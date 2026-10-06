import * as fs from "node:fs";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

export interface QuotaStatus {
  allowed: boolean;
  usedToday: number;
  limit: number;
  remainingToday: number;
  warning: boolean;
}

export function createQuotaGuard(database: Database, configPath?: string) {
  let dailyLimit = 50;
  let warningThreshold = 40;

  try {
    const resolvedPath =
      configPath ??
      path.resolve(
        process.env.TENANT_PACKAGE_DIR ?? "F:/projects/steel-directory",
        "quota-config.yaml",
      );
    if (fs.existsSync(resolvedPath)) {
      const content = fs.readFileSync(resolvedPath, "utf8");
      const limitMatch = content.match(/dailySearchQuotaLimit:\s*(\d+)/);
      if (limitMatch) dailyLimit = Number.parseInt(limitMatch[1], 10);
      const warnMatch = content.match(/warningThreshold:\s*(\d+)/);
      if (warnMatch) warningThreshold = Number.parseInt(warnMatch[1], 10);
    }
  } catch {
    // Keep defaults if config file reading fails
  }

  return {
    getLimit: () => dailyLimit,

    async checkQuota(): Promise<QuotaStatus> {
      // Calculate today's start in Asia/Shanghai
      const now = new Date();
      const shanghaiDateStr = now.toLocaleDateString("en-CA", {
        timeZone: "Asia/Shanghai",
      }); // "YYYY-MM-DD"
      const startOfDay = new Date(`${shanghaiDateStr}T00:00:00+08:00`);

      const [res]: any = await database.execute(sql`
        SELECT COALESCE(SUM(quota_cost), 0)::int as used
        FROM directory_crawler_tasks
        WHERE track = 'search_api'
          AND updated_at >= ${startOfDay.toISOString()}::timestamptz
      `);

      const usedToday = res?.used ?? 0;
      const remainingToday = Math.max(0, dailyLimit - usedToday);
      const allowed = remainingToday > 0;
      const warning = usedToday >= warningThreshold;

      return {
        allowed,
        usedToday,
        limit: dailyLimit,
        remainingToday,
        warning,
      };
    },
  };
}
