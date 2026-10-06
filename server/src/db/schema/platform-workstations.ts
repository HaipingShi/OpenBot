/**
 * Steel Information Source Platform Local Workstations & Regional Branches Table
 * 
 * Records physical workstation offices, regional hubs, branch companies,
 * station managers/reporters, direct phone lines, and physical addresses
 * across major steel trade portals (兰格钢铁, 中钢网, 找钢网, 我的钢铁网).
 */

import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const directoryPlatformWorkstations = pgTable(
  "directory_platform_workstations",
  {
    id: text("id").primaryKey(), // 唯一主键，如 ws_lgmi_baotou_01, ws_zgw_zz_01
    platform: text("platform").notNull(), // 信源平台：兰格钢铁 | 中钢网 | 找钢网 | 我的钢铁网
    branchName: text("branch_name").notNull(), // 机构全称：包头办事处、郑州分公司、唐山站等
    regionType: text("region_type").notNull().default("city"), // city (城市分站) | macro_region (大区) | headquarters (总部/垂直品类)
    macroRegion: text("macro_region"), // 归属大区：华北区、华东区、中原区、西北区、华南区、西南区等
    province: text("province"), // 归属省份：内蒙古、山东、河北、河南、上海、广东等
    city: text("city").notNull(), // 核心城市：包头、济南、唐山、郑州、西安、佛山等
    district: text("district"), // 区县：昆区、历城区、路北区、金水区等
    leaderName: text("leader_name"), // 负责人姓名：张燕、訾玉海、陈凯、王敬超等
    title: text("title"), // 职务头衔：办事处负责人、山东大区总监、分公司经理等
    phone: text("phone"), // 原始登记联络电话
    phoneNormalized: text("phone_normalized"), // 纯数字规范化电话 (便于快速检索与排重)
    additionalContacts: jsonb("additional_contacts").default([]), // 多联系人数组: [{ name: "徐楠楠", phone: "13314862189" }, ...]
    email: text("email"), // 业务邮箱
    address: text("address"), // 实体办公详细地址
    marketOrPark: text("market_or_park"), // 所在实体钢材市场或园区：畅达钢材市场、汇金中心、绿地国际花都等
    businessScope: text("business_scope"), // 业务职责范围：广告招商、本地钢贸商联络、价格采价、现货交割
    sourceUrl: text("source_url"), // 溯源页面链接
    verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("platform_workstations_platform_city_idx").on(table.platform, table.city),
    index("platform_workstations_city_idx").on(table.city),
    index("platform_workstations_leader_idx").on(table.leaderName),
    index("platform_workstations_phone_idx").on(table.phoneNormalized),
  ]
);

export type PlatformWorkstation = typeof directoryPlatformWorkstations.$inferSelect;
export type NewPlatformWorkstation = typeof directoryPlatformWorkstations.$inferInsert;
