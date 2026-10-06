import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import type { AdBannerCandidate } from "./ad-scraper";

export interface CrawlerTask {
  taskId: string;
  track: "hydration_free" | "search_api" | "ad_vision";
  city: string;
  category: string;
  queryOrUrl: string;
  status: "pending" | "running" | "completed" | "failed" | "rate_limited";
  attempts: number;
  quotaCost: number;
  entriesFound: number;
  phonesFound: number;
  lastRunAt: Date | null;
  errorMessage: string | null;
}

export interface TaskSummary {
  totalTasks: number;
  completedTasks: number;
  pendingTasks: number;
  rateLimitedTasks: number;
  failedTasks: number;
  runningTasks: number;
  totalEntriesFound: number;
  totalPhonesFound: number;
  totalQuotaCost: number;
  trackBreakdown: {
    track: string;
    total: number;
    completed: number;
    pending: number;
    entries: number;
    phones: number;
    quota: number;
  }[];
}

export function createTaskLedger(database: Database) {
  return {
    /**
     * Parse seeds.yaml and generate orthogonal task shards into directory_crawler_tasks.
     * Existing tasks are preserved via ON CONFLICT DO NOTHING.
     */
    async syncTasksFromSeeds(seedsPath?: string): Promise<{ addedCount: number; totalCount: number }> {
      const resolvedPath =
        seedsPath ??
        path.resolve(
          process.env.TENANT_PACKAGE_DIR ?? "F:/projects/steel-directory",
          "seeds.yaml",
        );

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`seeds.yaml not found at ${resolvedPath}`);
      }

      const content = fs.readFileSync(resolvedPath, "utf8");

      // Simple robust YAML regex parser for regions and categories
      const cities: string[] = [];
      const cityMatches = content.matchAll(/- city:\s*["']?([^"'\n\r]+)["']?/g);
      for (const m of cityMatches) {
        if (m[1]) cities.push(m[1].trim());
      }

      const categories: string[] = [];
      const catMatches = content.matchAll(/- category:\s*["']?([^"'\n\r]+)["']?/g);
      for (const m of catMatches) {
        if (m[1]) categories.push(m[1].trim());
      }

      const shards: { city: string; name: string; keyword: string }[] = [];
      // Extract shard blocks
      const regionBlocks = content.split(/- city:/g).slice(1);
      for (const block of regionBlocks) {
        const cityLine = block.split("\n")[0].replace(/["']/g, "").trim();
        const shardMatches = block.matchAll(/- name:\s*["']?([^"'\n\r]+)["']?[\s\S]*?keywords:\s*\[(.*?)\]/g);
        for (const sm of shardMatches) {
          const sName = sm[1].trim();
          const kwList = sm[2].split(",").map((k) => k.replace(/["']/g, "").trim()).filter(Boolean);
          for (const kw of kwList) {
            shards.push({ city: cityLine, name: sName, keyword: kw });
          }
        }
      }

      let generatedTasks: {
        taskId: string;
        track: "hydration_free" | "search_api";
        city: string;
        category: string;
        queryOrUrl: string;
      }[] = [];

      // 1. Track A (hydration_free): City x Category orthogonal shards for Zhaogang & Zhonggang
      for (const city of cities) {
        for (const cat of categories) {
          // Shard A1: Zhaogang Resources search query
          const zgQuery = `${city} ${cat.replace(/流通|采购|标讯|与配送/g, "")}`;
          generatedTasks.push({
            taskId: `shard:hydration:zhaogang:${city}:${cat}`,
            track: "hydration_free",
            city,
            category: cat,
            queryOrUrl: `https://aimall.zhaogang.com/resources?sc=${encodeURIComponent(zgQuery)}`,
          });

          // Shard A2: Zhonggang GSM query
          generatedTasks.push({
            taskId: `shard:hydration:zhonggang:${city}:${cat}`,
            track: "hydration_free",
            city,
            category: cat,
            queryOrUrl: `https://www.zgw.com/GSM/GetShopListPage?city=${encodeURIComponent(city)}&cat=${encodeURIComponent(cat)}`,
          });
        }
      }

      // 2. Track B (search_api): Precision regional clusters & associations
      for (const s of shards) {
        const taskId = `shard:search:${s.city}:${s.name}:${Buffer.from(s.keyword).toString("hex").slice(0, 8)}`;
        generatedTasks.push({
          taskId,
          track: "search_api",
          city: s.city,
          category: s.name,
          queryOrUrl: s.keyword,
        });
      }

      let insertedCount = 0;
      for (const t of generatedTasks) {
        const [res]: any = await database.execute(sql`
          INSERT INTO directory_crawler_tasks (task_id, track, city, category, query_or_url, status)
          VALUES (${t.taskId}, ${t.track}, ${t.city}, ${t.category}, ${t.queryOrUrl}, 'pending')
          ON CONFLICT (task_id) DO NOTHING
          RETURNING task_id;
        `);
        if (res) insertedCount++;
      }

      const [totalRow]: any = await database.execute(sql`SELECT count(*)::int as count FROM directory_crawler_tasks`);
      return { addedCount: insertedCount, totalCount: totalRow?.count ?? 0 };
    },

    /**
     * Claim the next pending task, locking it atomically.
     */
    async claimNextTask(options?: { track?: string; city?: string }): Promise<CrawlerTask | null> {
      const trackClause = options?.track && options.track !== "all"
        ? sql`AND track = ${options.track}`
        : sql``;
      const cityClause = options?.city
        ? sql`AND city = ${options.city}`
        : sql``;

      const rows: any = await database.execute(sql`
        UPDATE directory_crawler_tasks
        SET status = 'running',
            attempts = attempts + 1,
            last_run_at = now(),
            updated_at = now()
        WHERE task_id = (
          SELECT task_id
          FROM directory_crawler_tasks
          WHERE status = 'pending'
            ${trackClause}
            ${cityClause}
          ORDER BY attempts ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *;
      `);

      if (!rows || rows.length === 0) return null;
      const r = rows[0];
      return {
        taskId: r.task_id,
        track: r.track,
        city: r.city,
        category: r.category,
        queryOrUrl: r.query_or_url,
        status: r.status,
        attempts: r.attempts,
        quotaCost: r.quota_cost,
        entriesFound: r.entries_found,
        phonesFound: r.phones_found,
        lastRunAt: r.last_run_at,
        errorMessage: r.error_message,
      };
    },

    /**
     * Record task completion, failure, or rate-limited state.
     */
    async recordTaskResult(
      taskId: string,
      result: {
        status: "completed" | "failed" | "rate_limited";
        quotaCost: number;
        entriesFound: number;
        phonesFound: number;
        errorMessage?: string | null;
      },
    ): Promise<void> {
      await database.execute(sql`
        UPDATE directory_crawler_tasks
        SET status = ${result.status},
            quota_cost = quota_cost + ${result.quotaCost},
            entries_found = entries_found + ${result.entriesFound},
            phones_found = phones_found + ${result.phonesFound},
            error_message = ${result.errorMessage ?? null},
            updated_at = now()
        WHERE task_id = ${taskId};
      `);
    },

    /**
     * Get aggregate status report for monitoring and review.
     */
    async getStatusSummary(): Promise<TaskSummary> {
      const [totals]: any = await database.execute(sql`
        SELECT 
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
          COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
          COUNT(*) FILTER (WHERE status = 'rate_limited')::int as rate_limited,
          COUNT(*) FILTER (WHERE status = 'failed')::int as failed,
          COUNT(*) FILTER (WHERE status = 'running')::int as running,
          COALESCE(SUM(entries_found), 0)::int as total_entries,
          COALESCE(SUM(phones_found), 0)::int as total_phones,
          COALESCE(SUM(quota_cost), 0)::int as total_quota
        FROM directory_crawler_tasks;
      `);

      const tracks: any = await database.execute(sql`
        SELECT 
          track,
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
          COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
          COALESCE(SUM(entries_found), 0)::int as entries,
          COALESCE(SUM(phones_found), 0)::int as phones,
          COALESCE(SUM(quota_cost), 0)::int as quota
        FROM directory_crawler_tasks
        GROUP BY track
        ORDER BY track;
      `);

      return {
        totalTasks: totals?.total ?? 0,
        completedTasks: totals?.completed ?? 0,
        pendingTasks: totals?.pending ?? 0,
        rateLimitedTasks: totals?.rate_limited ?? 0,
        failedTasks: totals?.failed ?? 0,
        runningTasks: totals?.running ?? 0,
        totalEntriesFound: totals?.total_entries ?? 0,
        totalPhonesFound: totals?.total_phones ?? 0,
        totalQuotaCost: totals?.total_quota ?? 0,
        trackBreakdown: (tracks || []).map((t: any) => ({
          track: t.track,
          total: t.total,
          completed: t.completed,
          pending: t.pending,
          entries: t.entries,
          phones: t.phones,
          quota: t.quota,
        })),
      };
    },

    /**
     * Reset rate_limited or failed tasks back to pending for retry/resume.
     */
    async resetPending(includeFailed = false): Promise<number> {
      const statusFilter = includeFailed
        ? sql`status IN ('rate_limited', 'failed', 'running')`
        : sql`status IN ('rate_limited', 'running')`;

      const rows: any = await database.execute(sql`
        UPDATE directory_crawler_tasks
        SET status = 'pending',
            updated_at = now()
        WHERE ${statusFilter}
        RETURNING task_id;
      `);
      return rows ? rows.length : 0;
    },

    /**
     * Reset tasks of a specific track back to pending.
     */
    async resetTrack(track: string, onlyZeroEntries = false): Promise<number> {
      const condition = onlyZeroEntries
        ? sql`track = ${track} AND (entries_found = 0 OR entries_found IS NULL)`
        : sql`track = ${track}`;

      const rows: any = await database.execute(sql`
        UPDATE directory_crawler_tasks
        SET status = 'pending',
            updated_at = now()
        WHERE ${condition}
        RETURNING task_id;
      `);
      return rows ? rows.length : 0;
    },

    /**
     * Synchronize discovered commercial ad banner candidates into directory_crawler_tasks.
     * Generates a deterministic hash task_id for zero duplication across runs.
     */
    async syncAdTasks(candidates: AdBannerCandidate[]): Promise<{ addedCount: number; totalCount: number }> {
      let insertedCount = 0;
      const CITIES = [
        "北京", "天津", "唐山", "邯郸", "无锡", "杭州", "郑州", "西安", "广州",
        "武汉", "成都", "乌鲁木齐", "济南", "兰州", "包头", "石家庄", "太原",
        "重庆", "长沙", "南京", "雄安", "青岛", "合肥", "福州", "南昌", "大连"
      ];

      for (const ad of candidates) {
        // Deterministic task ID based on image URL and target URL
        const hash = createHash("sha256")
          .update(`${ad.platform}|${ad.imageUrl}|${ad.targetUrl || ""}`)
          .digest("hex")
          .slice(0, 24);
        const taskId = `ad_${hash}`;

        // Infer regional city
        let matchedCity = "全国";
        for (const c of CITIES) {
          if ((ad.placementType && ad.placementType.includes(c)) || (ad.pageUrl && ad.pageUrl.includes(c))) {
            matchedCity = c;
            break;
          }
        }

        // Store candidate payload in query_or_url
        const payload = JSON.stringify({
          platform: ad.platform,
          imageUrl: ad.imageUrl,
          targetUrl: ad.targetUrl,
          pageUrl: ad.pageUrl,
          altText: ad.altText,
          placementType: ad.placementType,
        });

        const res: any = await database.execute(sql`
          INSERT INTO directory_crawler_tasks (task_id, track, city, category, query_or_url, status)
          VALUES (${taskId}, 'ad_vision', ${matchedCity}, ${ad.placementType || "商业广告位"}, ${payload}, 'pending')
          ON CONFLICT (task_id) DO NOTHING
          RETURNING task_id;
        `);

        if (res && res.length > 0) insertedCount++;
      }

      const [totalRow]: any = await database.execute(sql`
        SELECT count(*)::int as count FROM directory_crawler_tasks WHERE track = 'ad_vision'
      `);
      return { addedCount: insertedCount, totalCount: totalRow?.count ?? 0 };
    },

    /**
     * Reset stale running ad tasks (e.g. from interrupted process or crash) back to pending.
     */
    async resetStaleAdTasks(timeoutMinutes: number = 10): Promise<number> {
      const rows: any = await database.execute(sql`
        UPDATE directory_crawler_tasks
        SET status = 'pending',
            updated_at = now()
        WHERE track = 'ad_vision' 
          AND status = 'running'
          AND updated_at < now() - (${timeoutMinutes} || ' minutes')::interval
        RETURNING task_id;
      `);
      return rows ? rows.length : 0;
    },

    /**
     * Retry failed ad tasks by resetting them to pending.
     */
    async retryFailedAdTasks(): Promise<number> {
      const rows: any = await database.execute(sql`
        UPDATE directory_crawler_tasks
        SET status = 'pending',
            updated_at = now()
        WHERE track = 'ad_vision' AND status = 'failed'
        RETURNING task_id;
      `);
      return rows ? rows.length : 0;
    },
  };
}
