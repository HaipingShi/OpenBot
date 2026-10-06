/**
 * Ad Intent Entity Reconciler & Enrichment Engine
 * 
 * Reconciles vision OCR extracted commercial entities with PostgreSQL directory assets:
 * - Upgrades existing companies with ad_intent = true and appends ad_platforms
 * - Creates new candidate entries for newly discovered advertisers
 * - Records high-confidence phone claims and product assertions
 * - Preserves snapshot audit chain
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { createSteelDirectoryStore } from "./store";
import type { AdBannerCandidate } from "./ad-scraper";
import type { AdOcrExtraction } from "./ad-vision-ocr";

const AGENT_ID = "agent_ad_vision_runner";

export interface ReconciliationResult {
  entryId: string;
  companyName: string;
  isNew: boolean;
  platformAdded: boolean;
  newPhonesCount: number;
  newClaimsCount: number;
}

export function createAdReconciler(database: Database) {
  const store = createSteelDirectoryStore(database);

  return {
    async reconcileAdLead(
      ad: AdBannerCandidate,
      ocr: AdOcrExtraction,
    ): Promise<ReconciliationResult | null> {
      if (!ocr.companyName) {
        return null;
      }

      const compName = ocr.companyName.trim();
      const normName = compName.toLowerCase().replace(/[\s\p{P}]+/gu, "");

      // Step 1: Check if company already exists in directory_entries
      const [existing]: any = await database.execute(sql`
        SELECT id, name, region, ad_intent, ad_platforms, ad_details 
        FROM directory_entries 
        WHERE name_normalized = ${normName} 
           OR name = ${compName}
        LIMIT 1;
      `);

      let entryId: string;
      let isNew = false;
      let platformAdded = false;

      const adDetailItem = {
        platform: ad.platform,
        placement: ad.placementType || "商业横幅广告",
        imageUrl: ad.imageUrl,
        targetUrl: ad.targetUrl || null,
        slogan: ocr.slogan || null,
        capturedAt: new Date().toISOString(),
      };

      if (existing) {
        entryId = existing.id;
        const currentPlatforms: string[] = existing.ad_platforms || [];
        if (!currentPlatforms.includes(ad.platform)) {
          platformAdded = true;
        }

        // Update existing entry with ad intent and platform
        await database.execute(sql`
          UPDATE directory_entries
          SET ad_intent = true,
              ad_platforms = array_append(
                array_remove(COALESCE(ad_platforms, '{}'::text[]), ${ad.platform}),
                ${ad.platform}
              ),
              ad_details = COALESCE(ad_details, '[]'::jsonb) || ${JSON.stringify([adDetailItem])}::jsonb,
              ad_intent_score = GREATEST(COALESCE(ad_intent_score, 0.0), 1.0),
              updated_at = now()
          WHERE id = ${entryId};
        `);
      } else {
        isNew = true;
        platformAdded = true;

        // Insert new entry with ad intent attributes
        const { entry } = await store.recordEntry({
          name: compName,
          region: ocr.region || "全国",
          entryType: "trader",
          confidence: ocr.confidence,
          agentId: AGENT_ID,
        });
        entryId = entry.id;

        await database.execute(sql`
          UPDATE directory_entries
          SET ad_intent = true,
              ad_platforms = ARRAY[${ad.platform}],
              ad_details = ${JSON.stringify([adDetailItem])}::jsonb,
              ad_intent_score = 1.0,
              updated_at = now()
          WHERE id = ${entryId};
        `);
      }

      // Step 2: Record Snapshot for Auditability
      try {
        await database.execute(sql`
          INSERT INTO directory_snapshots (
            id, source_id, url, content_fingerprint, title, excerpt, captured_by_agent
          ) VALUES (
            ${`snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`},
            ${`src_${ad.platform}`},
            ${ad.imageUrl},
            ${ocr.fingerprint},
            ${`${ad.platform}广告横幅 - ${compName}`},
            ${`OCR提取：${compName} | 手机：${ocr.phones.join("/")} | 口号：${ocr.slogan || "无"}`},
            ${AGENT_ID}
          )
          ON CONFLICT (url, content_fingerprint) DO NOTHING;
        `);
      } catch {
        // Snapshot preservation non-fatal
      }

      // Step 3: Record Direct Phone Claims
      let newPhonesCount = 0;
      for (const phone of ocr.phones) {
        try {
          const { duplicate } = await store.recordPhoneClaim({
            entryId,
            phone,
            evidenceQuote: `【${ad.platform}广告直达】${compName} 商业横幅广告印刷销售专线：${phone}（标语：${ocr.slogan || "无"}）`,
            phoneType: phone.startsWith("1") ? "mobile" : "landline",
            label: "门户广告位核心销售专线",
            sourceUrl: ad.imageUrl,
            confidence: 0.95, // Commercial banner ads carry very high contact authenticity
            agentId: AGENT_ID,
          });

          if (!duplicate) {
            newPhonesCount++;
          }
        } catch {
          // Phone record error non-fatal
        }
      }

      // Step 4: Record Product Claims
      let newClaimsCount = 0;
      const validProducts = (ocr.products || []).filter(
        (p) => p && !p.includes("未能识别") && !p.includes("无法识别") && p.length > 1,
      );
      if (validProducts.length > 0) {
        try {
          await store.recordClaim({
            entryId,
            field: "main_products",
            value: validProducts.join(","),
            evidenceQuote: `【${ad.platform}广告主推规格】${compName} 广告横幅重点推广品类：${validProducts.join("、")}`,
            sourceUrl: ad.imageUrl,
            confidence: 0.90,
            agentId: AGENT_ID,
          });
          newClaimsCount++;
        } catch {
          // Claim record error non-fatal
        }
      }

      return {
        entryId,
        companyName: compName,
        isNew,
        platformAdded,
        newPhonesCount,
        newClaimsCount,
      };
    },
  };
}
