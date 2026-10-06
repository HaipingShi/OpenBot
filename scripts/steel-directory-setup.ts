/**
 * Make the enterprise-directory team usable: register the capability, offer its tools, grant them
 * per Bot, and put the one guard a policy cannot be written without.
 *
 * WHY THIS IS A SCRIPT AND NOT A SCREEN. Nothing here is a decision somebody makes once and revises:
 * it is the same eight calls every time a deployment is set up, and the only thing that varies is
 * which Bot holds which tool. A script is that in a form somebody can read, re-run and put in the
 * repository beside the package it belongs to. It is also idempotent, deliberately — running it
 * twice must be as safe as running it once, because the ordinary case is running it again after
 * editing `agents.yaml`.
 *
 * WHAT IT DOES NOT DO. It does not decide anything about sources, claims or companies: the directory
 * is empty when this finishes, which is the correct state. It does not approve anything, and it
 * cannot — an approval is a person's and is recorded from a conversation.
 *
 *   bun run steel:setup
 */

/**
 * The catalogue key, which prefixes every tool name and is what a grant and a policy rule are
 * written against. Kept in one place so a rename is one edit.
 */
const SERVER = "steel-directory";

/**
 * Which Bot holds which tool.
 *
 * THIS IS THE TEAM, in the only form that actually constrains anything. The `agents.yaml` prompts
 * describe what each Bot is for and the skills say how to do it; this decides what each one can
 * reach, which is what a deployment's boundary is made of. A Bot missing from a list is not offered
 * that tool and cannot call it — there is no fallback and no way to talk past it.
 *
 * LEAN ON PURPOSE, and narrower than the prompts might suggest. The resolver cannot record a claim
 * and the extractor cannot merge two companies, so a mistake in one stage cannot be papered over by
 * the Bot that notice it: the work has to go back through the coordinator, which is where the record
 * of who did what stays readable.
 */
const GRANTS: Record<string, string[]> = {
  // Reads everything, writes the record of decisions and nothing else. The coordinator is the only
  // Bot that also holds a `bot` grant — see below — so it is the only one that can hand work on.
  "steel-directory-coordinator": [
    "list_sources",
    "search_entries",
    "list_claims",
    "list_review_queue",
    "record_review_decision",
    "gpsx-search/aggregate_search",
  ],
  // Finds pages and registers them. It never records a fact: its product is a list of addresses.
  // `read_page` works headless (it reads through the deployment's computer gateway), so the scout
  // can check what a page actually is even from a handoff run with no screen attached.
  "steel-source-scout": [
    "list_sources",
    "read_page",
    "record_source",
    "mark_source_blocked",
    "search_entries",
    "gpsx-search/aggregate_search",
    "gpsx-search/read_url",
  ],
  // Reads pages and snapshots them. It records no fact either — the snapshot is the artefact.
  "steel-snapshot-crawler": [
    "list_sources",
    "read_page",
    "record_snapshot",
    "mark_source_blocked",
    "gpsx-search/read_url",
  ],
  // The only Bot that writes claims and phone numbers. It can read the page it extracts from, which
  // matters headless: a run with no browser can still open the snapshotted URL and quote it.
  "steel-evidence-extractor": [
    "search_entries",
    "list_claims",
    "read_page",
    "record_entry",
    "record_claim",
    "record_phone_claim",
    "gpsx-search/read_url",
  ],
  // The only Bot that may merge, and it may not record the facts a merge is scored on.
  "steel-entity-resolver": [
    "search_entries",
    "list_claims",
    "resolve_entry",
    "queue_review",
  ],
  // Cross-checks and queues. It cannot merge, cannot record facts, and cannot decide a review item.
  "steel-verification-qa": [
    "search_entries",
    "list_claims",
    "list_review_queue",
    "verify_entry",
    "queue_review",
  ],
};

/**
 * Which Bot may hand work to which.
 *
 * A `bot` grant is directional and is the only way one Bot reaches another: the coordinator may
 * address the five specialists, and no specialist may address anybody. That is what keeps a chain
 * one hop deep and the record of a task readable from a single conversation.
 *
 * Skipped entirely when the package's Bots are not registered — a deployment running the fintech
 * package has no coordinator, and a grant naming a Bot that does not exist is refused by the API
 * rather than stored.
 */
const HANDOFFS = [
  "steel-source-scout",
  "steel-snapshot-crawler",
  "steel-evidence-extractor",
  "steel-entity-resolver",
  "steel-verification-qa",
];

/**
 * The one rule worth writing before anything has gone wrong.
 *
 * A team whose whole subject is other people's websites will meet password fields — an association
 * portal, a member login, a form that is not the sign-in it looks like. The prompt says not to, and
 * a prompt is not a boundary. This refuses any typing into a field whose label reads as a password
 * or a verification code, for every Bot in this deployment, and it refuses keys sent to one — a Bot
 * that tab-completes its way into a sign-in form is doing the same thing by another route.
 *
 * NOT THE WHOLE BOUNDARY, and not offered as one. It says nothing about clicking a "sign in" button
 * on a page nobody has credentials for, and no rule could: a page that refuses this deployment is
 * recorded and skipped, which is what `mark_source_blocked` is for. This is the mechanical half.
 */
const PASSWORD_FIELD_RULE =
  '(tool.name == "computer_type" || tool.name == "computer_key") && ' +
  '(contains(element.name, "password") || contains(element.name, "Password") || ' +
  'contains(element.name, "密码") || contains(element.name, "验证码") || ' +
  'contains(element.name, "captcha") || contains(element.name, "Captcha"))';

const base = process.env.OPENBOT_API_URL?.trim() || "http://localhost:3001";

/**
 * One authenticated request to the running server.
 *
 * Through the API rather than through the stores directly, because the API is where the grants are
 * checked by the code that enforces them and around which the audit rows are written. A script that
 * wrote rows straight into the database would produce a deployment that looks configured and has no
 * record of who configured it.
 */
async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: init.body ? { "content-type": "application/json" } : {},
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: the raw text is what a person needs to see, and a proxy or a sign-in page arriving
    // here is a real failure worth showing rather than swallowing.
  }
  return { ok: response.ok, status: response.status, data };
}

const say = (message: string) => console.info(`  ${message}`);

console.info(`Enterprise directory setup against ${base}\n`);

/* ------------------------------------------------------------------ the capability itself */

const health = await api("/api/capabilities");
if (!health.ok) {
  console.error(
    `The server at ${base} did not answer /api/capabilities (${health.status}). Start it first: bash scripts/start.sh`,
  );
  process.exit(1);
}

const servers = await api("/api/plugins");
const installed = Array.isArray(
  (servers.data as { servers?: unknown[] })?.servers,
)
  ? (servers.data as { servers: { id: string }[] }).servers
  : [];
if (installed.some((server) => server.id === SERVER)) {
  say(`${SERVER} is already registered; refreshing what it offers.`);
} else {
  const added = await api("/api/plugins/servers", {
    method: "POST",
    body: { key: SERVER },
  });
  if (!added.ok) {
    console.error(
      `Could not register ${SERVER}: ${added.status} ${JSON.stringify(added.data)}`,
    );
    process.exit(1);
  }
  say(
    `Registered ${SERVER} — the catalogue's own address, no URL and no credential.`,
  );
}

/*
 * Refreshed rather than assumed. The tool list lives in `mcp_tools` and is what a grant has to name,
 * so a deployment whose catalogue entry gained a tool since the last run needs this to have happened
 * before the grants below can name it.
 */
const refreshed = await api(`/api/plugins/servers/${SERVER}/refresh`, {
  method: "POST",
});
if (!refreshed.ok) {
  console.error(
    `Could not refresh ${SERVER}: ${refreshed.status} ${JSON.stringify(refreshed.data)}`,
  );
  process.exit(1);
}
const tools = (refreshed.data as { tools?: number }).tools ?? 0;
say(`Offering ${tools} tools.`);

/* ---------------------------------------------------------------------------------- grants */

const agents = await api("/api/agents");
const registered = new Set(
  Array.isArray((agents.data as { agents?: unknown[] })?.agents)
    ? (agents.data as { agents: { id: string }[] }).agents.map(
        (agent) => agent.id,
      )
    : [],
);

let granted: string[] = [];
for (const [agentId, refs] of Object.entries(GRANTS)) {
  if (!registered.has(agentId)) {
    say(`${agentId} is not registered in this deployment; skipping its tools.`);
    continue;
  }
  for (const tool of refs) {
    const ref = tool.includes("/") ? tool : `${SERVER}/${tool}`;
    const result = await api("/api/plugins/grants", {
      method: "POST",
      body: { kind: "mcp", ref, agentId },
    });
    // A grant that is already there answers with an error; that is the idempotent case, not a
    // failure, and saying so for every tool on every run would drown the ones that are news.
    if (result.ok || result.status === 409 || result.status === 400) {
      granted = [...granted, `${agentId}:${tool}`];
    } else {
      console.error(
        `  ! ${agentId} could not be granted ${tool}: ${result.status} ${JSON.stringify(result.data)}`,
      );
    }
  }
}
say(`Grants in place: ${granted.length}.`);

/* -------------------------------------------------------------------------------- handoffs */

let hops = 0;
if (registered.has("steel-directory-coordinator")) {
  for (const target of HANDOFFS) {
    if (!registered.has(target)) continue;
    const result = await api("/api/plugins/grants", {
      method: "POST",
      body: {
        kind: "bot",
        ref: target,
        agentId: "steel-directory-coordinator",
      },
    });
    if (result.ok || result.status === 409 || result.status === 400) hops += 1;
    else {
      console.error(
        `  ! the coordinator could not be granted ${target}: ${result.status} ${JSON.stringify(result.data)}`,
      );
    }
  }
  say(`Handoffs: the coordinator may address ${hops} specialists.`);
} else {
  say("No coordinator registered, so no handoff grants were made.");
}

/* ---------------------------------------------------------------------------------- policy */

/*
 * The password-field rule is ADDED to whatever this deployment already enforces, never substituted
 * for it. `PUT /api/computers/policy` is a full replacement — the policy is one row and one object,
 * which is the right shape for a boundary somebody edits as a whole — so the current rules are read
 * first and the new one is merged in. A script that wrote its own object would silently discard
 * every rule an administrator had added.
 */
const current = await api("/api/computers/policy");
if (!current.ok) {
  console.error(
    `Could not read the current policy (${current.status}); leaving it alone. The team works without this rule, but nothing stops a Bot typing into a password field.`,
  );
} else {
  const policy = (
    current.data as {
      policy?: { mode?: string; deny?: string[]; allow?: string[] };
    }
  )?.policy;
  const deny = Array.isArray(policy?.deny) ? policy.deny : [];
  if (deny.includes(PASSWORD_FIELD_RULE)) {
    say("The password-field rule is already in force.");
  } else {
    const saved = await api("/api/computers/policy", {
      method: "PUT",
      body: {
        mode: policy?.mode === "dry-run" ? "dry-run" : "enforce",
        deny: [...deny, PASSWORD_FIELD_RULE],
        allow:
          Array.isArray(policy?.allow) && policy.allow.length > 0
            ? policy.allow
            : ["true"],
      },
    });
    if (saved.ok) {
      say(
        `Policy: added one rule (deny typing into password and verification-code fields), keeping the ${deny.length} rule(s) already there.`,
      );
    } else {
      console.error(
        `  ! the policy was not updated: ${saved.status} ${JSON.stringify(saved.data)}`,
      );
    }
  }
}

/* ---------------------------------------------------------------------------------- report */

const finalServers = await api("/api/plugins");
const toolsHeld = (
  (
    finalServers.data as {
      servers?: {
        id: string;
        /* The catalogue as the API serves it: one row per tool, not a count. */
        tools?: unknown[];
        lastError?: string | null;
      }[];
    }
  )?.servers ?? []
).find((server) => server.id === SERVER);

console.info(`\nDone.`);
console.info(
  `  ${SERVER}: ${toolsHeld?.tools?.length ?? tools} tools${toolsHeld?.lastError ? ` — last error: ${toolsHeld.lastError}` : ""}.`,
);
console.info(
  `  ${Object.keys(GRANTS).length} Bots configured, ${granted.length} grants, ${hops} handoffs.`,
);
console.info(`
Next:
  1. Open http://localhost:3010 and go to the "Directory Command" channel.
  2. Ask the coordinator for something concrete and bounded, such as:
       "Find 10 steel trading companies in Tianjin: register the sources, read them,
        and record what they say."
  3. When it reports what is waiting, go to the "Review Queue" channel and decide the items.
  4. The collected numbers, and everything else, are in the database:
       select * from directory_phone_claims where review_status = 'pending' order by created_at;
       select * from directory_entries order by updated_at desc limit 50;
       select * from directory_review_decisions order by decided_at desc;`);
