import { GifReader } from "omggif";
import { PNG } from "pngjs";

async function analyzeLgmi() {
  console.log("=== 正在深度探测 兰格钢铁 (LGMI) 页面层级与广告结构 ===");
  const res = await fetch("https://www.lgmi.com/", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
  });
  const html = await res.text();

  // 1. City / Regional Hubs
  const cityMatches = html.matchAll(/href=["']([^"']*city_[^"']*)["']/gi);
  const cities = new Set<string>();
  for (const m of cityMatches) cities.add(m[1]);
  console.log("发现区域/城市分站入口:", Array.from(cities));

  // 2. Subdomains
  const subMatch = html.matchAll(/https?:\/\/([a-z0-9\-_]+)\.lgmi\.com/gi);
  const subdomains = new Set<string>();
  for (const m of subMatch) subdomains.add(m[1]);
  console.log("发现核心二级子域:", Array.from(subdomains));

  // 3. Ad Image Patterns (guanggao.lgmi.com, gifs, banners)
  const adMatches = html.matchAll(/(?:href=["']([^"']*)["'][^>]*>)?[\s\S]*?<img\s+[^>]*src=["']([^"']*(?:guanggao|download|UpLoad|banner)[^"']*)["']/gi);
  let adCount = 0;
  let gifCount = 0;
  for (const m of adMatches) {
    adCount++;
    if (m[2].toLowerCase().includes(".gif")) gifCount++;
  }
  console.log(`首页分析结果: 广告图片块数量 ${adCount} 个, 其中动图(GIF) ${gifCount} 个`);
}

async function analyzeZgw() {
  console.log("\n=== 正在深度探测 中钢网 (ZGW) 页面层级与广告结构 ===");
  const res = await fetch("https://www.zgw.com/", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
  });
  const html = await res.text();

  // Subdomains / Channels
  const subMatch = html.matchAll(/https?:\/\/([a-z0-9\-_]+)\.zgw\.com/gi);
  const subdomains = new Set<string>();
  for (const m of subMatch) subdomains.add(m[1]);
  console.log("发现核心二级子域/频道:", Array.from(subdomains));

  // Commercial banner regex
  const adMatches = html.matchAll(/(?:UploadFile\/ZGPerson|UploadFile\/ProofPic|UploadFile\/Ad)[^\s"'<>]+\.(?:jpg|png|gif)/gi);
  const adUrls = new Set<string>();
  for (const m of adMatches) adUrls.add(m[0]);
  console.log("发现商业投放展位图片块:", adUrls.size, "个");
}

async function main() {
  await analyzeLgmi();
  await analyzeZgw();
}

main().catch(console.error);
