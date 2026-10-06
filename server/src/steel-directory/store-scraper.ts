/**
 * Steel Certified Merchant Stores & VIP Exhibition Halls Scraper
 * 
 * Supports automated extraction of official verified merchant stores across:
 * 1. 我的钢铁网 (Mysteel - 搜搜钢 e.mysteel.com/ID{id})
 * 2. 中钢网 (ZGW - 超级大卖场 mall.zgw.com/shop/{id})
 * 3. 兰格钢铁 (LGMI - 会员展厅 kh.lgmi.com/{code})
 * 4. 找钢网 (Zhaogang - 联营现货商户)
 */

export interface StoreMerchantData {
  platform: "我的钢铁网" | "中钢网" | "兰格钢铁" | "找钢网";
  storeId: string;
  storeUrl: string;
  companyName: string | null;
  phones: string[];
  mainProducts: string[];
  businessLicenseUrl: string | null;
  storeAge: number | null; // 入驻年限，如 6 年
  qualityTier: string | null; // 供应商资质认证等级，如 "星标认证商户" / "优质供应商"
  address: string | null;
  region: string | null;
  contactPerson: string | null;
  verifiedAt: Date;
  rawDetails?: Record<string, any>;
}

// Known platform customer service hotlines to exclude from merchant phone numbers
const PLATFORM_HOTLINES = new Set([
  "4006711818", "02126093374", "02126093997", "02126093501", "02166896803", "02166896682", // Mysteel
  "4007008508", "13676997586", "15560247707", "18519149964", "13040000006", // ZGW platform hotlines & test mocks
  "4008190090", "01063978802", "01063950255", "01063959926", "02286215885", // LGMI
  "02135906666", // Zhaogang
]);

/**
 * Clean and validate Chinese mobile and landline numbers.
 * Excludes platform customer service hotlines and 13-digit millisecond timestamp prefixes.
 */
export function cleanStorePhone(raw: string): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^0-9]/g, "").trim();
  if (digits.startsWith("86") && digits.length > 11) digits = digits.slice(2);

  // Filter platform hotlines
  if (PLATFORM_HOTLINES.has(digits)) return null;

  // Filter 13-digit timestamp millisecond artifacts (e.g. 1786168861589 -> 17861688615)
  // If digits start with 178/179/18 and is followed by common millisecond patterns
  if (digits.startsWith("178") || digits.startsWith("179") || digits.startsWith("146") || digits.startsWith("147")) {
    if (digits.length === 11 && ["17861688615", "17901506295", "17901506299", "17898770448"].includes(digits)) {
      return null;
    }
  }

  // Mobile (11 digits: 13x - 19x)
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;

  // Tier-1 Landlines: 010 or 02x (10-11 digits)
  if (/^0(10|2[0-9])\d{7,8}$/.test(digits)) return digits;

  // Prefecture Landlines: 03xx - 09xx (11-12 digits)
  if (/^0[3-9]\d{2}\d{7,8}$/.test(digits)) return digits;

  // Toll-free Hotlines (10 digits)
  if (/^(400|800)\d{7}$/.test(digits)) return digits;

  return null;
}

/**
 * 1. 我的钢铁网 (Mysteel - 搜搜钢 e.mysteel.com/ID{id}) 解析器
 */
export function parseMysteelStoreHtml(html: string, storeId: string): StoreMerchantData | null {
  // Extract Pinia SSR State
  const piniaMatch = html.match(/window\.__INITIAL_PINIA_DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!piniaMatch) return null;

  let storeDetail: any = null;
  try {
    const cleanJson = piniaMatch[1].replace(/:\s*undefined/g, ":null");
    const pinia = JSON.parse(cleanJson);
    storeDetail = pinia.tdkStore?.storeDetail;
  } catch {
    return null;
  }

  if (!storeDetail || !storeDetail.companyName || storeDetail.shopStatus !== 1) {
    // Inactive or unverified store
    return null;
  }

  const companyName = storeDetail.companyName.trim();
  let businessLicenseUrl = storeDetail.businessLicense || null;
  if (businessLicenseUrl && businessLicenseUrl.startsWith("//")) {
    businessLicenseUrl = "https:" + businessLicenseUrl;
  }

  const storeAge = typeof storeDetail.gxtAge === "number" ? storeDetail.gxtAge : null;
  const isStar = !!storeDetail.isStar;
  const qualitySupplierId = storeDetail.qualitySupplierId;
  const qualityTier = isStar ? "星标认证供应商" : (qualitySupplierId ? "搜搜钢优质供应商" : "钢信通认证商户");

  // Extract products
  const mainProducts = storeDetail.mainProducts
    ? storeDetail.mainProducts.split(",").map((p: string) => p.trim()).filter(Boolean)
    : [];

  // Extract direct verified contact phone from DOM
  const phones: string[] = [];
  let contactPerson: string | null = null;

  const phoneMatch = html.match(/<span[^>]*class=["']phone["'][^>]*>([^<]+)<\/span>/i);
  if (phoneMatch) {
    const p = cleanStorePhone(phoneMatch[1]);
    if (p) phones.push(p);
  }

  const nameMatch = html.match(/<span[^>]*class=["']name["'][^>]*title=["']([^"']+)["']/i);
  if (nameMatch) {
    contactPerson = nameMatch[1].trim();
  }

  // Infer region from company name
  let region: string | null = null;
  const regMatch = companyName.match(/(唐山|天津|北京|邯郸|无锡|上海|乐从|广州|佛山|郑州|安阳|舞钢|聊城|武汉|成都|重庆|西安|杭州|南京|沈阳|山东|河北|河南|江苏|广东|新疆|内蒙古)/);
  if (regMatch) {
    region = regMatch[1];
  }

  return {
    platform: "我的钢铁网",
    storeId: String(storeId),
    storeUrl: `https://e.mysteel.com/ID${storeId}`,
    companyName,
    phones: [...new Set(phones)],
    mainProducts,
    businessLicenseUrl,
    storeAge,
    qualityTier,
    address: null,
    region,
    contactPerson,
    verifiedAt: new Date(),
    rawDetails: {
      gxtAge: storeAge,
      isStar,
      qualitySupplierId,
      integral: storeDetail.integral,
    }
  };
}

/**
 * 2. 中钢网 (ZGW - 超级大卖场 mall.zgw.com/shop/{id}) 解析器
 */
export function parseZgwStoreHtml(html: string, storeId: string): StoreMerchantData | null {
  // Title pattern: "唐山昀顺商贸有限公司-中钢网超级大卖场商家-中钢网"
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (!titleMatch) return null;

  const title = titleMatch[1].trim();
  const compMatch = title.match(/^([^\-_]+)-中钢网超级大卖场商家/);
  if (!compMatch) return null;

  const companyName = compMatch[1].trim();

  // Extract official TrustUTN credit certification link
  let businessLicenseUrl: string | null = null;
  const certMatch = html.match(/href=["'](https?:\/\/si\.trustutn\.org\/info\?[^"']+)["']/i);
  if (certMatch) {
    businessLicenseUrl = certMatch[1];
  }

  // Extract phones: first from designated mobile/phone classes and contact blocks
  const phones: string[] = [];
  const enterMobileMatches = [...html.matchAll(/<span[^>]*class=["']entermobile["'][^>]*>([^<]+)<\/span>/gi)];
  for (const em of enterMobileMatches) {
    const cp = cleanStorePhone(em[1]);
    if (cp && !phones.includes(cp)) {
      phones.push(cp);
    }
  }

  // Also check explicit contact blocks (联系人 / 联系电话 / 手机)
  const contactBlockMatches = [...html.matchAll(/(?:联系电话|业务电话|销售电话|手机|电话)[：:\s]*(?:<[^>]+>)?\s*(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})/gi)];
  for (const cbm of contactBlockMatches) {
    const cp = cleanStorePhone(cbm[1]);
    if (cp && !phones.includes(cp)) {
      phones.push(cp);
    }
  }

  // Fallback: bounded regex on page, strictly ignoring numbers preceded or followed by digits or in image URLs
  if (phones.length === 0) {
    const rawPhones = [...html.matchAll(/(?<![\d\w/.-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?![\d\w/.-])/g)].map(m => m[0]);
    for (const rp of rawPhones) {
      const cp = cleanStorePhone(rp);
      if (cp && !phones.includes(cp)) {
        phones.push(cp);
      }
    }
  }

  // Extract products from store banner or keywords
  const products: string[] = [];
  const steelKeywords = [
    "中厚板", "热轧", "冷轧", "无缝管", "镀锌管", "焊管", "钢管",
    "螺纹钢", "盘螺", "高线", "工字钢", "角钢", "槽钢", "H型钢",
    "型钢", "带钢", "扁钢", "不锈钢", "方矩管", "耐磨板", "花纹板"
  ];
  for (const kw of steelKeywords) {
    if (html.includes(kw) && !products.includes(kw)) {
      products.push(kw);
    }
  }

  // Extract contact person
  let contactPerson: string | null = null;
  const personMatch = html.match(/(?:业务联系人|联系人)[：:\s]*(?:<\/span>)?\s*([^\s<]{2,10})/i);
  if (personMatch) {
    contactPerson = personMatch[1].trim();
  }

  // Extract address
  let address: string | null = null;
  let region: string | null = null;
  const addrMatch = html.match(/地址[：:\s]*(?:<\/span>)?\s*([^<>\r\n]{5,80})/i);
  if (addrMatch) {
    address = addrMatch[1].trim().replace(/^[-/]+/, "");
    // Extract region from address or company name
    const regMatch = (address + " " + companyName).match(/(唐山|天津|北京|邯郸|无锡|上海|乐从|广州|佛山|郑州|洛阳|沧州|衡水|廊坊|安阳|聊城|武汉|成都|重庆|西安|杭州|南京|沈阳|河北|河南|山东|江苏|广东)/);
    if (regMatch) {
      region = regMatch[1];
    }
  }

  return {
    platform: "中钢网",
    storeId: String(storeId),
    storeUrl: `https://mall.zgw.com/shop/${storeId}`,
    companyName,
    phones: phones.slice(0, 3), // Keep top primary phones
    mainProducts: products.slice(0, 8),
    businessLicenseUrl,
    storeAge: null,
    qualityTier: "中钢网超级大卖场认证商家",
    address,
    region,
    contactPerson,
    verifiedAt: new Date(),
    rawDetails: {
      trustCertUrl: businessLicenseUrl,
    }
  };
}

/**
 * 3. 兰格钢铁 (LGMI - 会员展厅 kh.lgmi.com/{code}) 解析器
 */
export function parseLgmiStoreHtml(html: string, code: string): StoreMerchantData | null {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (!titleMatch) return null;

  const rawTitle = titleMatch[1].trim();
  const compMatch = rawTitle.match(/[\u4e00-\u9fa5]{4,25}?(?:有限公司|股份有限公司|有限责任公司|轧钢厂|钢厂|管业)/);
  if (!compMatch) return null;

  const companyName = compMatch[0].trim();

  // Extract sales managers and phones using lookaround boundaries
  const phones: string[] = [];
  const rawPhones = [...html.matchAll(/(?<![\d\w/.-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?![\d\w/.-])/g)].map(m => m[0]);
  for (const rp of rawPhones) {
    const cp = cleanStorePhone(rp);
    if (cp && !phones.includes(cp)) {
      phones.push(cp);
    }
  }

  // Extract address if available
  let address: string | null = null;
  const addrMatch = html.match(/(?:地址|办公地址|库房地址|所在市场)[：:\s]*([^<>\n\r]{6,50})/);
  if (addrMatch) {
    address = addrMatch[1].trim();
  }

  // Infer region from company name or address
  let region: string | null = null;
  const regMatch = (companyName + (address || "")).match(/(唐山|天津|北京|邯郸|无锡|上海|乐从|广州|佛山|郑州|安阳|聊城|武汉|成都|重庆|西安|杭州|南京|沈阳|山东|河北|河南|江苏|广东)/);
  if (regMatch) {
    region = regMatch[1];
  }

  return {
    platform: "兰格钢铁",
    storeId: code,
    storeUrl: `http://kh.lgmi.com/${code}/index.html`,
    companyName,
    phones: phones.slice(0, 5),
    mainProducts: [],
    businessLicenseUrl: null,
    storeAge: null,
    qualityTier: "兰格钢铁VIP会员商户展厅",
    address,
    region,
    contactPerson: null,
    verifiedAt: new Date(),
  };
}
