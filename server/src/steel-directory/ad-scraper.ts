/**
 * Steel Portal Commercial Ad Banner Scraper
 * 
 * Targets commercial advertising placements, sponsor strips, and merchant banners
 * across major Chinese steel trading portals (中钢网, 兰格钢铁, 找钢网, 我的钢铁网).
 */

export interface AdBannerCandidate {
  platform: string;
  pageUrl: string;
  imageUrl: string;
  targetUrl?: string;
  altText?: string;
  containerText?: string;
  placementType?: string;
}

export interface PortalScrapeTarget {
  name: string;
  platform: string;
  pages: { url: string; placement: string }[];
}

export const PORTAL_TARGETS: PortalScrapeTarget[] = [
  {
    name: "中钢网 (ZGW)",
    platform: "中钢网",
    pages: [
      { url: "https://www.zgw.com/", placement: "首页轮播与赞助商横幅" },
      { url: "https://mall.zgw.com/", placement: "现货商城精选广告" },
      { url: "https://www.zgw.com/GSM/", placement: "钢材超市品牌专区" },
      { url: "https://hq.zgw.com/", placement: "行情中心黄金展位" },
      { url: "https://gangguan.zgw.com/", placement: "钢管专区品牌展位" },
      { url: "https://shangxie.zgw.com/", placement: "商协会百强联展" },
    ],
  },
  {
    name: "兰格钢铁 (LGMI)",
    platform: "兰格钢铁",
    pages: [
      { url: "https://www.lgmi.com/", placement: "门户核心企业横幅" },
      { url: "https://meeting.lgmi.com/", placement: "行业峰会与论坛赞助商" },
      // 垂直品类大厅
      { url: "https://jiancai.lgmi.com/", placement: "建材垂直大厅展位" },
      { url: "https://bancai.lgmi.com/", placement: "板材垂直大厅展位" },
      { url: "https://guancai.lgmi.com/", placement: "管材垂直大厅展位" },
      { url: "https://xingcai.lgmi.com/", placement: "型材垂直大厅展位" },
      // 核心钢铁商贸重镇城市分站
      { url: "https://www.lgmi.com/index/city_beijing.htm", placement: "北京区域商贸广告位" },
      { url: "https://www.lgmi.com/index/city_tianjin.htm", placement: "天津大邱庄商贸广告位" },
      { url: "https://www.lgmi.com/index/city_tangshan.htm", placement: "唐山丰润商圈广告位" },
      { url: "https://www.lgmi.com/index/city_handan.htm", placement: "邯郸华北重镇广告位" },
      { url: "https://www.lgmi.com/index/city_wuxi.htm", placement: "无锡东方钢材城广告位" },
      { url: "https://www.lgmi.com/index/city_hangzhou.htm", placement: "杭州钱江商贸广告位" },
      { url: "https://www.lgmi.com/index/city_zhengzhou.htm", placement: "郑州中原物流圈广告位" },
      { url: "https://www.lgmi.com/index/city_xian.htm", placement: "西安西北大仓储广告位" },
      { url: "https://www.lgmi.com/index/city_guangzhou.htm", placement: "华南乐从辐射圈广告位" },
      { url: "https://www.lgmi.com/index/city_wuhan.htm", placement: "武汉舵落口市场广告位" },
      { url: "https://www.lgmi.com/index/city_chengdu.htm", placement: "成都量力钢材城广告位" },
      { url: "https://www.lgmi.com/index/city_wulumuqi.htm", placement: "乌鲁木齐大宗枢纽广告位" },
      { url: "https://www.lgmi.com/index/city_jinan.htm", placement: "济南商贸流通广告位" },
      { url: "https://www.lgmi.com/index/city_lanzhou.htm", placement: "兰州西北集散广告位" },
      { url: "https://www.lgmi.com/index/city_baotou.htm", placement: "包头特钢无缝管广告位" },
      { url: "https://www.lgmi.com/index/city_shijiazhuang.htm", placement: "石家庄省会商圈广告位" },
      { url: "https://www.lgmi.com/index/city_taiyuan.htm", placement: "太原不锈钢重镇广告位" },
      { url: "https://www.lgmi.com/index/city_chongqing.htm", placement: "重庆西南枢纽广告位" },
      { url: "https://www.lgmi.com/index/city_changsha.htm", placement: "长沙大托商圈广告位" },
      { url: "https://www.lgmi.com/index/city_nanjing.htm", placement: "南京长江中下游广告位" },
    ],
  },
  {
    name: "找钢网 (Zhaogang)",
    platform: "找钢网",
    pages: [
      { url: "https://www.zhaogang.com/", placement: "首页金牌现货商推荐" },
      { url: "https://xingguan.zhaogang.com/resources", placement: "型管现货大厅顶置推荐" },
    ],
  },
  {
    name: "我的钢铁网 (Mysteel)",
    platform: "我的钢铁网",
    pages: [
      { url: "https://eces.mysteel.com/22/0104/15/75E3F6DCE0D99EE2.html", placement: "全国钢贸百强商业展位" },
    ],
  },
];

function resolveUrl(baseUrl: string, relativeUrl: string): string {
  try {
    let normalized = relativeUrl.replace(/\\/g, "/").trim();
    if (normalized.startsWith("//")) {
      return `https:${normalized}`.replace(/([^:])\/\/+/g, "$1/");
    }
    const resolved = new URL(normalized, baseUrl).href;
    return resolved.replace(/([^:])\/\/+/g, "$1/");
  } catch {
    return relativeUrl;
  }
}

function isAdImage(src: string, href?: string, alt?: string): boolean {
  const lowerSrc = src.toLowerCase();
  const lowerHref = (href || "").toLowerCase();
  const lowerAlt = (alt || "").toLowerCase();

  // Exclude common site UI assets & navigation controls
  if (
    lowerSrc.includes("logo") ||
    lowerSrc.includes("icon") ||
    lowerSrc.includes("avatar") ||
    lowerSrc.includes("foot") ||
    lowerSrc.includes("nav") ||
    lowerSrc.includes("button") ||
    lowerSrc.includes("btn") ||
    lowerSrc.includes("arrow") ||
    lowerSrc.includes("loading") ||
    lowerSrc.includes("qrcode") ||
    lowerSrc.includes("accordion") ||
    lowerSrc.includes("indexnew") ||
    lowerSrc.includes("common") ||
    lowerSrc.includes("default") ||
    lowerSrc.includes("wx.") ||
    lowerSrc.includes("app.") ||
    lowerSrc.includes("appv2services") ||
    lowerSrc.includes("/product/") ||
    lowerSrc.includes("/images/product/") ||
    lowerSrc.endsWith(".svg")
  ) {
    return false;
  }

  // Strong positive signals for commercial ads
  const hasAdKeywords =
    lowerSrc.includes("uploadfile") ||
    lowerSrc.includes("guanggao") ||
    lowerSrc.includes("upload") ||
    lowerSrc.includes("banner") ||
    lowerSrc.includes("adv") ||
    lowerSrc.includes("download") ||
    lowerHref.includes("guanggao") ||
    lowerHref.includes("company") ||
    lowerAlt.includes("钢") ||
    lowerAlt.includes("板") ||
    lowerAlt.includes("管") ||
    lowerAlt.includes("材") ||
    lowerAlt.includes("有限公司");

  return hasAdKeywords;
}

/**
 * Scrape commercial ad banners from a target portal page.
 */
export async function scrapePageAds(
  pageUrl: string,
  platform: string,
  placement: string,
): Promise<AdBannerCandidate[]> {
  const candidates: AdBannerCandidate[] = [];
  const seenImageUrls = new Set<string>();

  try {
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });

    if (!res.ok) {
      console.warn(`[AdScraper] Failed to fetch ${pageUrl}: HTTP ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Strategy 1: Linked Banner Images (<a href="...">...<img src="...">...</a>)
    const linkedImgRegex =
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?<img\s+[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?)<\/a>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkedImgRegex.exec(html)) !== null) {
      const rawHref = lm[1].trim();
      const innerHtml = lm[2];
      const rawSrc = lm[3].trim();

      const altMatch = innerHtml.match(/alt=["']([^"']+)["']/i);
      const titleMatch = innerHtml.match(/title=["']([^"']+)["']/i);
      const altText = altMatch?.[1] || titleMatch?.[1] || "";

      if (isAdImage(rawSrc, rawHref, altText)) {
        const fullImgUrl = resolveUrl(pageUrl, rawSrc);
        const fullTargetUrl = resolveUrl(pageUrl, rawHref);

        if (!seenImageUrls.has(fullImgUrl)) {
          seenImageUrls.add(fullImgUrl);
          candidates.push({
            platform,
            pageUrl,
            imageUrl: fullImgUrl,
            targetUrl: fullTargetUrl,
            altText,
            placementType: placement,
          });
        }
      }
    }

    // Strategy 2: Standalone Commercial Banners (inside banner & floating containers)
    const containerRegex =
      /<(?:div|li|section|ul)\s+[^>]*(?:class|id)=["'][^"']*(?:banner|adv|ad-|swiper-slide|layer_advert|float-ad|windows|sponsor|brand-logos)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li|section|ul)>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = containerRegex.exec(html)) !== null) {
      const containerHtml = cm[1];
      const imgMatches = containerHtml.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi);
      for (const im of imgMatches) {
        const rawSrc = im[1].trim();
        const altMatch = im[0].match(/alt=["']([^"']+)["']/i);
        const altText = altMatch?.[1] || "";

        if (isAdImage(rawSrc, undefined, altText)) {
          const fullImgUrl = resolveUrl(pageUrl, rawSrc);
          if (!seenImageUrls.has(fullImgUrl)) {
            seenImageUrls.add(fullImgUrl);
            candidates.push({
              platform,
              pageUrl,
              imageUrl: fullImgUrl,
              altText,
              placementType: placement,
            });
          }
        }
      }
    }

    // Strategy 3: Dedicated Commercial Ad Clusters (UploadFile, guanggao.lgmi.com, newapp.lgmi.com, oss)
    const directUploadRegex =
      /(?:https?:)?\/\/[^\s"'<>]*(?:UploadFile\/ZGPerson|UploadFile\/ProofPic|UploadFile\/Ad|guanggao\.lgmi\.com|newapp\.lgmi\.com\/UpLoad|lgmi-com\.oss)[^\s"'<>]+\.(?:jpg|png|webp|gif)/gi;
    const directMatches = html.match(directUploadRegex) || [];
    for (const rawUrl of directMatches) {
      const fullImgUrl = resolveUrl(pageUrl, rawUrl);
      if (!seenImageUrls.has(fullImgUrl)) {
        seenImageUrls.add(fullImgUrl);
        candidates.push({
          platform,
          pageUrl,
          imageUrl: fullImgUrl,
          placementType: placement,
        });
      }
    }
  } catch (err: any) {
    console.warn(`[AdScraper] Error scraping ${pageUrl}: ${err.message}`);
  }

  return candidates;
}
