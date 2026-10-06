import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { createRoutineStore } from "../src/routines/store";
import { channels, channelAgents, users } from "../src/db/schema";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
);
const routineStore = createRoutineStore(database);

async function run() {
  console.info("=== Setting up OpenBot Steel Directory Routine Schedule ===");

  // Find a user/owner
  const [user] = await database.select().from(users).limit(1);
  const ownerId = user?.id ?? "dev-local-user";

  // Find channel for steel-directory-coordinator
  const [member] = await database
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(sql`agent_id = 'steel-directory-coordinator'`)
    .limit(1);

  const channelId = member?.channelId;
  console.info(`Target Owner: ${ownerId}, Target Channel: ${channelId || "(none yet)"}`);

  const instruction =
    "执行每日钢铁商贸名录增量采集：运行找钢网与中钢网水合直取流水线，抓取最新挂牌与入驻企业，完成事实与电话录入，并将待决事项推入审核队列。";
  const cron = "30 3 * * *"; // Daily 03:30 AM

  try {
    const existing = await database.execute(
      sql`SELECT id, cron, enabled FROM routines WHERE agent_id = 'steel-directory-coordinator' LIMIT 1`,
    );
    if (existing.length > 0) {
      console.info(
        `Routine already in place for steel-directory-coordinator: ID ${existing[0].id}, cron: ${existing[0].cron}, enabled: ${existing[0].enabled}`,
      );
    } else if (channelId) {
      const routine = await routineStore.create({
        ownerUserId: ownerId,
        agentId: "steel-directory-coordinator",
        channelId,
        instruction,
        cron,
        timezone: "Asia/Shanghai",
      });
      console.info(
        `Created scheduled routine: ID ${routine.id}, Schedule: ${cron} (Asia/Shanghai), Next Run: ${routine.nextRunAt}`,
      );
    } else {
      console.info(
        "Coordinator channel is not yet opened in the UI. The routine can be initiated by asking Coordinator 'create a daily routine at 03:30 AM' or running crawl-zhaogang-stealth via crontab/task scheduler.",
      );
    }
  } catch (err: any) {
    console.warn("Routine setup note:", err.message);
  }

  console.info("\nScheduled Routine configuration check complete.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Routine setup error:", err);
  process.exit(1);
});
