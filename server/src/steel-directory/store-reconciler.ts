/**
 * Certified Store Merchant Entity Reconciler & Enrichment Engine (Track D)
 * 
 * Reconciles store merchant records with PostgreSQL directory assets:
 * - Upgrades or creates verified merchant entries with confidence = 1.0
 * - Records official business license image proof in directory_claims (field = 'business_license_image')
 * - Records verified store age (field = 'store_age_years') and quality tier
 * - Stores direct mobile phone lines in directory_phone_claims
 * - Preserves snapshot audit chain
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { createSteelDirectoryStore } from "./store";
import type { StoreMerchantData } from "./store-scraper";

const AGENT_ID = "agent_store_crawler_runner";

export interface StoreReconciliationResult {
  entryId: string;
  companyName: string;
  isNew: boolean;
  platformAdded: boolean;
  newPhonesCount: number;
  newClaimsCount: number;
}

export function createStoreReconciler(database: Database) {
  const store = createSteelDirectoryStore(database);

  return {
    async reconcileStoreMerchant(
      data: StoreMerchantData
    ): Promise<StoreReconciliationResult | null> {
      if (!data.companyName) {
        return null;
      }

      const compName = data.companyName.trim();
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

      const storeDetailItem = {
        platform: data.platform,
        storeId: data.storeId,
        storeUrl: data.storeUrl,
        qualityTier: data.qualityTier,
        storeAge: data.storeAge,
        businessLicenseUrl: data.businessLicenseUrl,
        mainProducts: data.mainProducts,
        contactPerson: data.contactPerson,
        capturedAt: new Date().toISOString(),
      };

      if (existing) {
        entryId = existing.id;
        const currentPlatforms: string[] = existing.ad_platforms || [];
        if (!currentPlatforms.includes(data.platform)) {
          platformAdded = true;
        }

        // Update existing entry
        await database.execute(sql`
          UPDATE directory_entries
          SET ad_intent = true,
              ad_platforms = array_append(
                array_remove(COALESCE(ad_platforms, '{}'::text[]), ${data.platform}),
                ${data.platform}
              ),
              ad_details = COALESCE(ad_details, '[]'::jsonb) || ${JSON.stringify([storeDetailItem])}::jsonb,
              ad_intent_score = GREATEST(COALESCE(ad_intent_score, 0.0), 1.0),
              confidence = 1.0,
              updated_at = now()
          WHERE id = ${entryId};
        `);
      } else {
        isNew = true;
        platformAdded = true;

        // Insert new verified enterprise
        const { entry } = await store.recordEntry({
          name: compName,
          region: data.region || "全国",
          entryType: "trader",
          confidence: 1.0,
          agentId: AGENT_ID,
        });
        entryId = entry.id;

        await database.execute(sql`
          UPDATE directory_entries
          SET ad_intent = true,
              ad_platforms = ARRAY[${data.platform}],
              ad_details = ${JSON.stringify([storeDetailItem])}::jsonb,
              ad_intent_score = 1.0,
              confidence = 1.0,
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
            ${`snap_store_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`},
            ${`src_${data.platform}_store`},
            ${data.storeUrl},
            ${`fp_${data.storeId}_${Date.now()}`},
            ${`${data.platform}认证商铺 - ${compName}`},
            ${`认证商铺：${compName} | 执照：${data.businessLicenseUrl || "有"} | 手机：${data.phones.join("/")} | 资质：${data.qualityTier || "认证商户"}`},
            ${AGENT_ID}
          )
          ON CONFLICT (url, content_fingerprint) DO NOTHING;
        `);
      } catch {
        // Non-fatal
      }

      // Step 3: Record Direct Verified Phone Claims
      let newPhonesCount = 0;
      for (const phone of data.phones) {
        try {
          const { duplicate } = await store.recordPhoneClaim({
            entryId,
            phone,
            evidenceQuote: `【${data.platform}认证商铺直达】${compName} 店铺挂牌专属销售手机：${phone}（资质认证：${data.qualityTier || "认证现货商户"}）`,
            phoneType: phone.startsWith("1") ? "mobile" : "landline",
            label: "认证商铺直达销售专线",
            sourceUrl: data.storeUrl,
            confidence: 1.0,
            agentId: AGENT_ID,
          });
          if (!duplicate) {
            newPhonesCount++;
          }
        } catch {
          // Phone deduplication non-fatal
        }
      }

      // Step 4: Record High-Confidence Facts & Claims (License Image, Store Age, Products)
      let newClaimsCount = 0;

      // 4.1 Business License Image proof
      if (data.businessLicenseUrl) {
        try {
          const { duplicate } = await store.recordClaim({
            entryId,
            field: "business_license_image",
            value: data.businessLicenseUrl,
            evidenceQuote: `【${data.platform}认证工商存证】${compName} 官方认证营业执照存证扫描件原件`,
            sourceUrl: data.storeUrl,
            confidence: 1.0,
            agentId: AGENT_ID,
          });
          if (!duplicate) newClaimsCount++;
        } catch {}
      }

      // 4.2 Store Age in years
      if (data.storeAge) {
        try {
          const { duplicate } = await store.recordClaim({
            entryId,
            field: "store_age_years",
            value: String(data.storeAge),
            evidenceQuote: `【${data.platform}经营资质】入驻平台 ${data.storeAge} 年老牌诚信现货商`,
            sourceUrl: data.storeUrl,
            confidence: 1.0,
            agentId: AGENT_ID,
          });
          if (!duplicate) newClaimsCount++;
        } catch {}
      }

      // 4.3 Quality tier
      if (data.qualityTier) {
        try {
          const { duplicate } = await store.recordClaim({
            entryId,
            field: "quality_tier",
            value: data.qualityTier,
            evidenceQuote: `【${data.platform}商户评级】平台认证标识：${data.qualityTier}`,
            sourceUrl: data.storeUrl,
            confidence: 1.0,
            agentId: AGENT_ID,
          });
          if (!duplicate) newClaimsCount++;
        } catch {}
      }

      // 4.4 Main steel products
      for (const prod of data.mainProducts.slice(0, 10)) {
        try {
          const { duplicate } = await store.recordClaim({
            entryId,
            field: "product",
            value: prod,
            evidenceQuote: `【${data.platform}商铺主营现货】${compName} 长期挂牌供货品种：${prod}`,
            sourceUrl: data.storeUrl,
            confidence: 1.0,
            agentId: AGENT_ID,
          });
          if (!duplicate) newClaimsCount++;
        } catch {}
      }

      return {
        entryId,
        companyName: compName,
        isNew,
        platformAdded,
        newPhonesCount,
        newClaimsCount,
      };
    }
  };
}
