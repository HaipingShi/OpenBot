/**
 * Steel Ad Banner Vision OCR Engine
 * 
 * Uses GLM-4V multimodal vision to extract enterprise names, direct contact numbers,
 * steel product categories, and commercial intent from banner images.
 */

import { createHash } from "node:crypto";
import type { AdBannerCandidate } from "./ad-scraper";
import { demuxAndStitchGif, isGifBuffer } from "./gif-demuxer";

export interface AdOcrExtraction {
  companyName: string | null;
  phones: string[];
  products: string[];
  region: string | null;
  slogan: string | null;
  hasAdIntent: boolean;
  fingerprint: string;
  confidence: number;
  rawText?: string;
}

const memoryOcrCache = new Map<string, AdOcrExtraction>();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function cleanPhone(phone: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^0-9]/g, "").trim();
  if (digits.startsWith("86")) digits = digits.slice(2);
  // Mobile (11 digits: 13x - 19x)
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
  // Tier-1 Landlines: 010 or 02x (10-11 digits)
  if (/^0(10|2[0-9])\d{7,8}$/.test(digits)) return digits;
  // Prefecture Landlines: 03xx - 09xx (11-12 digits)
  if (/^0[3-9]\d{2}\d{7,8}$/.test(digits)) return digits;
  // Toll-free Hotlines: 400xxxxxxx or 800xxxxxxx (10 digits)
  if (/^(400|800)\d{7}$/.test(digits)) return digits;
  return null;
}

export interface OcrOptions {
  provider?: "siliconflow" | "openai_vlm" | "paddle_ocr" | "glm" | "auto";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  paddleUrl?: string;
  paddleApiKey?: string;
}

const STEEL_KEYWORDS = [
  "中厚板", "热轧", "冷轧", "无缝管", "镀锌管", "焊管", "钢管",
  "螺纹钢", "盘螺", "高线", "工字钢", "角钢", "槽钢", "H型钢",
  "型钢", "带钢", "扁钢", "不锈钢", "方矩管", "耐磨板", "花纹板", "彩涂板"
];

function parsePaddleResponse(json: any): string[] {
  const texts: string[] = [];
  if (Array.isArray(json?.results)) {
    for (const group of json.results) {
      if (Array.isArray(group)) {
        for (const item of group) {
          if (item?.text) texts.push(item.text);
          else if (typeof item === "string") texts.push(item);
        }
      }
    }
  }
  if (Array.isArray(json?.words_result)) {
    for (const w of json.words_result) {
      if (w?.words) texts.push(w.words);
    }
  }
  if (Array.isArray(json?.data)) {
    for (const d of json.data) {
      if (typeof d === "string") texts.push(d);
      else if (d?.text) texts.push(d.text);
    }
  }
  return texts;
}

function parseOcrTextResults(texts: string[]): {
  company_name: string | null;
  phones: string[];
  products: string[];
  slogan: string | null;
} {
  let company_name: string | null = null;
  const phones: string[] = [];
  const products: string[] = [];
  const slogans: string[] = [];

  for (const t of texts) {
    const trimmed = t.trim();
    if (!company_name) {
      const compMatch = trimmed.match(/[\u4e00-\u9fa5]{4,25}?(?:有限公司|股份有限公司|有限责任公司|轧钢厂|钢厂|管业)/);
      if (compMatch) company_name = compMatch[0];
    }
    const phoneMatches = trimmed.matchAll(/(?:1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}|(?:400|800)[- ]?\d{3,4}[- ]?\d{3,4}|(?:400|800)\d{7})/g);
    for (const pm of phoneMatches) {
      const p = cleanPhone(pm[0]);
      if (p && !phones.includes(p)) phones.push(p);
    }
    for (const kw of STEEL_KEYWORDS) {
      if (trimmed.includes(kw) && !products.includes(kw)) {
        products.push(kw);
      }
    }
    if (trimmed.length >= 4 && trimmed.length <= 25 && !trimmed.includes("公司") && !trimmed.includes("电话")) {
      slogans.push(trimmed);
    }
  }

  return {
    company_name,
    phones,
    products,
    slogan: slogans.length > 0 ? slogans[0] : null,
  };
}

export async function parseAdBannerWithVision(
  ad: AdBannerCandidate,
  options?: OcrOptions,
): Promise<AdOcrExtraction | null> {
  // Provider resolution
  const paddleUrl = options?.paddleUrl || process.env.PADDLE_OCR_URL;
  const paddleApiKey = options?.paddleApiKey || process.env.PADDLE_OCR_API_KEY || process.env.PADDLE_OCR_TOKEN;
  
  const isPaddleMode = options?.provider === "paddle_ocr" || (!options?.provider && !!paddleUrl);

  const isSiliconFlow =
    options?.provider === "siliconflow" ||
    (!options?.provider && !isPaddleMode && !!process.env.SILICONFLOW_API_KEY);

  const apiKey =
    options?.apiKey ||
    (isSiliconFlow ? process.env.SILICONFLOW_API_KEY : process.env.OPENAI_API_KEY) ||
    "";
  const baseUrl =
    options?.baseUrl ||
    (isSiliconFlow
      ? (process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1")
      : (process.env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/coding/paas/v4"));
  const model =
    options?.model ||
    (isSiliconFlow
      ? (process.env.SILICONFLOW_MODEL || "Qwen/Qwen2-VL-72B-Instruct")
      : "glm-4v-flash");

  try {
    // Step 1: Download Image Buffer
    const imgRes = await fetch(ad.imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
      },
    });

    if (!imgRes.ok) {
      console.warn(`[AdVision] Failed to download image ${ad.imageUrl}: HTTP ${imgRes.status}`);
      return null;
    }

    const arrayBuf = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // Skip tiny images (< 4KB)
    if (buffer.byteLength < 4096) {
      return null;
    }

    const fingerprint = sha256(buffer);

    // Step 2: Check Fingerprint Cache
    if (memoryOcrCache.has(fingerprint)) {
      return memoryOcrCache.get(fingerprint)!;
    }

    let finalBuffer: any = buffer;
    let finalContentType = imgRes.headers.get("content-type") || "image/jpeg";

    // Handle Animated GIFs (demux multiple frames and vertically stitch to PNG filmstrip)
    if (isGifBuffer(buffer) || finalContentType.includes("gif") || ad.imageUrl.toLowerCase().endsWith(".gif")) {
      const demuxed = demuxAndStitchGif(buffer);
      if (demuxed) {
        finalBuffer = demuxed.stitchedPngBuffer;
        finalContentType = "image/png";
        console.info(`[AdVision] Successfully demuxed and stitched animated GIF (${demuxed.frameCount} frames) -> ${demuxed.width}x${demuxed.height} PNG filmstrip`);
      }
    }

    const base64 = finalBuffer.toString("base64");
    const dataUri = `data:${finalContentType};base64,${base64}`;

    let parsed: any = null;
    let rawContent = "";

    // Engine Branch A: Dedicated PaddleOCR Engine
    if (isPaddleMode && paddleUrl) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (paddleApiKey) {
          headers["Authorization"] = `Bearer ${paddleApiKey}`;
          headers["token"] = paddleApiKey;
        }

        const paddleRes = await fetch(paddleUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            image: base64,
            images: [base64],
          }),
        });

        if (paddleRes.ok) {
          const paddleJson = await paddleRes.json();
          rawContent = JSON.stringify(paddleJson);
          const detectedTexts = parsePaddleResponse(paddleJson);
          parsed = parseOcrTextResults(detectedTexts);
        }
      } catch (err: any) {
        console.warn(`[AdVision] PaddleOCR API error: ${err.message}`);
      }
    }
    // Engine Branch B: Multimodal Vision Model (SiliconFlow / GLM-4V / OpenAI-compatible)
    else {
      const prompt = `你是一个专业的钢铁产业商业广告与企业名录信息提取专家。
请仔细观察并识别这张钢铁行业门户广告图（Banner，若为多帧胶卷拼接图请结合所有分屏画面）中的文字与商业信息。
严格提取以下信息，并输出为规范有效的JSON对象：
{
  "company_name": "企业商户全称，例如：xx钢铁贸易有限公司，无法识别或仅为行业标语时填写null",
  "phones": ["销售经理手机号、固话或400专线电话数组"],
  "products": ["主营钢材产品品类数组，例如：中厚板、热轧卷板、无缝管、镀锌带钢"],
  "region": "所在城市、省份或钢材市场园区，例如：邯郸、乐从、无锡，未提及时填写null",
  "slogan": "广告宣传口号，例如：常年现货 规格齐全 厂价直配",
  "has_ad_intent": true
}

注意：
1. 优先提取清晰完整的企业全称（必须是合法商事主体或带有'厂'、'公司'、'经营部'）；
2. 广告图上的电话通常字号很大且醒目，请务必完整识别11位手机号或带区号固话；
3. 只能返回有效的标准JSON，禁止包含额外的对话文字或Markdown修饰外壳。`;

      const payload = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
        temperature: 0.1,
      };

      try {
        const cleanBaseUrl = baseUrl.endsWith("/chat/completions") ? baseUrl.slice(0, -"/chat/completions".length) : baseUrl;
        const visionRes = await fetch(`${cleanBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (visionRes.ok) {
          const resJson = await visionRes.json();
          rawContent = resJson?.choices?.[0]?.message?.content || "";
          const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          }
        } else {
          console.warn(`[AdVision] Vision API call failed: HTTP ${visionRes.status}`);
        }
      } catch (e: any) {
        console.warn(`[AdVision] Vision API call error: ${e.message}`);
      }
    }

    let companyName = parsed?.company_name || null;
    const rawPhones: string[] = Array.isArray(parsed?.phones) ? parsed.phones : [];
    const cleanedPhones = rawPhones.map(cleanPhone).filter(Boolean) as string[];

    // Fallback: If parsed is null or companyName is null, try extracting company and phones from rawContent
    if (!companyName && rawContent) {
      const compMatch = rawContent.match(/[\u4e00-\u9fa5]{4,25}?(?:有限公司|股份有限公司|有限责任公司|轧钢厂|钢厂|管业)/);
      if (compMatch) companyName = compMatch[0];
      const phoneMatches = rawContent.matchAll(/(?:1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}|(?:400|800)[- ]?\d{3,4}[- ]?\d{3,4}|(?:400|800)\d{7})/g);
      for (const pm of phoneMatches) {
        const p = cleanPhone(pm[0]);
        if (p && !cleanedPhones.includes(p)) cleanedPhones.push(p);
      }
    }

    // Step 4: Contextual Landing Page Enrichment (if targetUrl exists)
    if (ad.targetUrl) {
      try {
        const landingRes = await fetch(ad.targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(4000),
        });
        if (landingRes.ok) {
          const lHtml = await landingRes.text();
          const title = (lHtml.match(/<title>([^<]+)<\/title>/i)?.[1] || "").trim();
          const legalMatch = (title + " " + lHtml.slice(0, 3000)).match(/[\u4e00-\u9fa5]{4,25}?(?:有限公司|股份有限公司|有限责任公司)/);
          if (legalMatch && (!companyName || companyName.length < 5 || !companyName.includes("公司"))) {
            companyName = legalMatch[0];
          } else if (!companyName && title) {
            const cleanTitle = title.split(/[-_|,]/)[0].trim();
            if (cleanTitle.length >= 2 && cleanTitle.length <= 25 && !cleanTitle.includes("404") && !cleanTitle.includes("首页") && !cleanTitle.includes("undefined")) {
              companyName = cleanTitle;
            }
          }
          const phoneMatches = lHtml.matchAll(/(?:电话|手机|热线|联系|咨询|销售|Tel)[：:\s]*((?:1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}))/gi);
          for (const pm of phoneMatches) {
            const lp = cleanPhone(pm[1]);
            if (lp && !cleanedPhones.includes(lp) && cleanedPhones.length < 5) {
              cleanedPhones.push(lp);
            }
          }
        }
      } catch {
        // Landing page enrichment non-fatal
      }
    }

    // Step 5: Fallback to altText if still missing
    if (!companyName && ad.altText) {
      const compMatch = ad.altText.match(/[\u4e00-\u9fa5]{4,25}?(?:有限公司|股份有限公司|有限责任公司|轧钢厂|钢厂)/);
      if (compMatch) companyName = compMatch[0];
    }

    // Filter out portal self-promotions
    if (
      companyName &&
      (companyName.includes("兰格钢铁") ||
        companyName.includes("中钢网") ||
        companyName.includes("找钢网") ||
        companyName.includes("我的钢铁"))
    ) {
      companyName = null;
    }

    const products: string[] = Array.isArray(parsed?.products) ? parsed.products : [];
    const region: string | null = parsed?.region || null;
    const slogan: string | null = parsed?.slogan || null;
    const hasAdIntent = parsed?.has_ad_intent !== false;

    const result: AdOcrExtraction = {
      companyName,
      phones: cleanedPhones,
      products,
      region,
      slogan,
      hasAdIntent,
      fingerprint,
      confidence: companyName ? 0.95 : 0.6,
      rawText: rawContent,
    };

    memoryOcrCache.set(fingerprint, result);
    return result;
  } catch (err: any) {
    console.warn(`[AdVision] Vision OCR error on ${ad.imageUrl}: ${err.message}`);
    return null;
  }
}
