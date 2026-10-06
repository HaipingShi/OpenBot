/**
 * The enterprise directory: sources, snapshots, entities, claims and the human review queue.
 *
 * ITS OWN FILE, NOT ANOTHER TABLE IN coworker.ts, because this is one feature's data rather than a
 * platform primitive. Everything a Bot collects about an outside company lands here, and the shape
 * of it is decided by what an auditor has to be able to ask afterwards: which page said so, when it
 * was read, what exact words said it, and who decided to believe it.
 *
 * EVIDENCE IS A COLUMN PAIR, NOT A FOREIGN KEY ALONE. A claim carries `evidence_quote` beside the
 * snapshot it came from, because a snapshot id nobody can re-read is an assertion with a receipt
 * number and no receipt. The quote is the words that were on the page; the snapshot is the page. A
 * claim missing either is refused at the tool boundary rather than stored and argued about later.
 *
 * NOTHING HERE IS A FOREIGN KEY TO `users` OR `agents`. The rows outlive the Bot that wrote them and
 * may need to outlive the person who reviewed them — an audit of a directory read years later must
 * not lose its author to a cascade. The ids are kept as text, the way `audit_events` keeps its
 * target, and the trail and these tables are read together.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Where a fact about a company may come from, and what kind of page this is.
 *
 * A closed vocabulary rather than free text, so "show me everything we learned from tender notices"
 * is a query and not a scan of somebody's spelling. `directory` is the third-party aggregator case
 * — a site that lists companies — and is deliberately its own kind, because a directory page is
 * weak evidence for an operating-capability claim and strong evidence for a name existing.
 */
export const SOURCE_KINDS = [
  "official_site",
  "park",
  "association",
  "tender",
  "media",
  "directory",
  "other",
] as const;

/**
 * Whether this deployment may read the source, in the only three states that mean anything.
 *
 * `blocked` is not a failure to be retried. It is a decision a Bot recorded: the page wanted a
 * sign-in, a CAPTCHA or a subscription, this deployment does not sign in as anybody, and the source
 * is set aside until a person says otherwise. `unknown` is the honest state of a source registered
 * by a Bot that has not opened it yet.
 */
export const ACCESS_STATUSES = ["unknown", "open", "blocked"] as const;

/**
 * Why a source is set aside.
 *
 * Named rather than free text because the interesting question is a count: "how much of this
 * directory is behind a login wall" is answered by a `group by` on this column and by nothing else.
 * `robots` is separate from the rest because a site that said no in its robots.txt has made a
 * statement about permission, which is a different thing from a page that simply wants an account.
 */
export const BLOCKED_REASONS = [
  "login_wall",
  "captcha",
  "paywall",
  "robots",
  "gone",
  "other",
] as const;

/** What kind of company this is, from the evidence and not from the name. */
export const ENTRY_TYPES = [
  "producer",
  "processor",
  "trader",
  "buyer",
  "logistics",
  "service",
  "unknown",
] as const;

/** Where an entity sits between "a Bot wrote a name down" and "a person has looked at it". */
export const ENTRY_STATUSES = [
  "candidate",
  "active",
  "dormant",
  "merged",
  "rejected",
] as const;

/** The review state a person's decision leaves behind, on an entry or a claim. */
export const REVIEW_STATUSES = [
  "unreviewed",
  "pending",
  "approved",
  "rejected",
] as const;

/** What a phone number is for, which is the field a sales team actually uses. */
export const PHONE_TYPES = [
  "landline",
  "mobile",
  "hotline",
  "fax",
  "unknown",
] as const;

/** How a value was obtained. A rule that read a table is a different confidence from a model's guess. */
export const EXTRACTION_METHODS = ["rule", "model", "manual"] as const;

/** What a cross-check concluded. */
export const VERIFICATIONS = [
  "cross_checked",
  "contradicted",
  "needs_more_evidence",
] as const;

/** What a person decided about a queued item. */
export const REVIEW_DECISIONS = [
  "approve",
  "reject",
  "needs_more_evidence",
] as const;

/**
 * A page this deployment may read, registered before anything is read from it.
 *
 * REGISTERED FIRST, ON PURPOSE. A snapshot has to point at a source, and a source carries the
 * access decision — so "we were blocked here, and here is the date" is a fact about a page that
 * exists in the table whether or not a single field was ever extracted from it. A crawl that
 * produced nothing still leaves the reason behind.
 */
export const directorySources = pgTable(
  "directory_sources",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /** Lower-cased host. Kept beside the url so a policy rule can name a site without parsing. */
    host: text("host").notNull(),
    kind: text("kind").notNull(),
    accessStatus: text("access_status").notNull().default("unknown"),
    /** Null unless `access_status` is `blocked`. */
    blockedReason: text("blocked_reason"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    notes: text("notes"),
    /** Which Bot registered it. Text rather than a foreign key: see the module comment. */
    registeredByAgent: text("registered_by_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One row per address. Registering the same page twice is the ordinary case — two runs, two
    // Bots — and it must refine the row rather than duplicate it.
    uniqueIndex("directory_sources_url_key").on(table.url),
    index("directory_sources_host_idx").on(table.host),
    // The crawler's read: everything not yet set aside.
    index("directory_sources_access_idx").on(
      table.accessStatus,
      table.lastCheckedAt,
    ),
  ],
);

/**
 * One company.
 *
 * THE CREDIT CODE IS THE ANCHOR, and the partial unique index below is what makes that true rather
 * than aspirational: two rows cannot claim the same unified social credit code, so the code either
 * identifies a row or is absent. `name_normalized` exists for the other half of the same job —
 * "上海宝钢（集团）有限公司" and "上海宝钢集团有限公司" are one company spelled two ways, and a
 * lookup that compared the printed names would create two rows for it.
 *
 * A MERGED ROW STAYS. `merged_into_entry_id` is why: the loser of a merge keeps its name and its
 * id, so a claim, an audit row or a person's memory pointing at it still resolves to the company it
 * turned out to be. Deleting it would make every one of those references dangle.
 */
export const directoryEntries = pgTable(
  "directory_entries",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Case-folded, punctuation-stripped, whitespace-stripped. Written by the store, never a caller. */
    nameNormalized: text("name_normalized").notNull(),
    shortName: text("short_name"),
    creditCode: text("credit_code"),
    region: text("region"),
    entryType: text("entry_type").notNull().default("unknown"),
    website: text("website"),
    address: text("address"),
    legalRepresentative: text("legal_representative"),
    status: text("status").notNull().default("candidate"),
    /** How sure the last writer was, 0..1. A number a person can sort on, not a word. */
    confidence: real("confidence").notNull().default(0.5),
    reviewStatus: text("review_status").notNull().default("unreviewed"),
    /** Set on the loser of a merge. The row is kept and points at the survivor. */
    mergedIntoEntryId: text("merged_into_entry_id"),
    /** 是否有广告投放意向 / 付费广告商 */
    adIntent: boolean("ad_intent").notNull().default(false),
    /** 广告投放平台列表，如 ['中钢网', '兰格钢铁'] */
    adPlatforms: text("ad_platforms").array(),
    /** 广告位元数据详情与事实证据 */
    adDetails: jsonb("ad_details").default([]),
    /** 商业广告投放意向强度评分 (0.0 .. 1.0) */
    adIntentScore: real("ad_intent_score").notNull().default(0.0),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastVerifiedByAgent: text("last_verified_by_agent"),
    createdByAgent: text("created_by_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /*
     * Partial, because absent is not a value that collides. A unique index over the whole column
     * would allow exactly one row with a null code in PostgreSQL, which is the opposite of what is
     * wanted: most candidate rows have no code yet, and they are precisely the rows that still need
     * one.
     */
    uniqueIndex("directory_entries_credit_code_key")
      .on(table.creditCode)
      .where(sql`credit_code is not null`),
    index("directory_entries_name_idx").on(table.nameNormalized),
    index("directory_entries_region_idx").on(table.region),
    index("directory_entries_review_idx").on(table.reviewStatus, table.status),
    index("directory_entries_merged_idx").on(table.mergedIntoEntryId),
    index("directory_entries_ad_intent_idx")
      .on(table.adIntent)
      .where(sql`ad_intent = true`),
  ],
);

/**
 * One page as it was when a Bot read it.
 *
 * THE CONTENT IS NOT IN HERE. The column is a SHA-256 of the page body, not the body: a directory
 * run reads hundreds of pages, most of them somebody else's text, and a table that grows by the
 * internet is a table nobody can back up. What is kept is what an audit needs — the fingerprint (so
 * two runs that saw the same page are visibly the same page), the status, and a bounded excerpt. The
 * full text stays in the reading Bot's own workspace, which is where a re-read would look for it.
 *
 * THE FINGERPRINT IS ALSO THE DEDUPE. A re-crawl of an unchanged page is recognised here and
 * answers with the snapshot that already exists, so "nothing has changed since March" is a row a
 * person can read rather than a conclusion the model reached.
 */
export const directorySnapshots = pgTable(
  "directory_snapshots",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    /** The exact page, which for a crawl is usually deeper than the source's own address. */
    url: text("url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    httpStatus: integer("http_status"),
    /** SHA-256, lower-case hex. Required: a page nobody can identify is a page nobody can dedupe. */
    contentFingerprint: text("content_fingerprint").notNull(),
    title: text("title"),
    /** A bounded window of the page's text, so a claim's quote can be checked against its context. */
    excerpt: text("excerpt"),
    /** Set when this page could not be used, with the same vocabulary a source is blocked with. */
    blockedReason: text("blocked_reason"),
    capturedByAgent: text("captured_by_agent"),
    createdAt: createdAt(),
  },
  (table) => [
    index("directory_snapshots_source_idx").on(table.sourceId, table.fetchedAt),
    // The dedupe read, and the one an auditor uses to ask which claims came off one page.
    index("directory_snapshots_fingerprint_idx").on(table.contentFingerprint),
    uniqueIndex("directory_snapshots_url_fingerprint_key").on(
      table.url,
      table.contentFingerprint,
    ),
  ],
);

/**
 * One field of one company, as one page stated it.
 *
 * A CLAIM, NOT A COLUMN, and that is the whole design. A company's phone number is not one value
 * that a later writer overwrites; it is what three pages said, one of which is two years old. So the
 * value lands here with its quote, and `directory_entries` carries the current best answer. Two
 * pages disagreeing is represented rather than erased, which is exactly what the verification step
 * is for and what an auditor asks about.
 *
 * `verified_at` is null on everything a Bot wrote. It is set by `verify_entry` or by a person's
 * decision, so "has anybody checked this" is one predicate and not a judgement call.
 */
export const directoryClaims = pgTable(
  "directory_claims",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    /** The field name, from the store's own vocabulary. `website`, `address`, `capacity`, … */
    field: text("field").notNull(),
    value: text("value").notNull(),
    snapshotId: text("snapshot_id"),
    sourceUrl: text("source_url"),
    /** The words on the page that say this. Required; see the module comment. */
    evidenceQuote: text("evidence_quote").notNull(),
    /** Where on the page: a table row, a selector, a section heading. */
    evidenceLocator: text("evidence_locator"),
    extractionMethod: text("extraction_method").notNull().default("model"),
    confidence: real("confidence").notNull().default(0.5),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByAgent: text("verified_by_agent"),
    createdByAgent: text("created_by_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("directory_claims_entry_idx").on(table.entryId, table.field),
    index("directory_claims_snapshot_idx").on(table.snapshotId),
    index("directory_claims_unverified_idx").on(table.verifiedAt),
  ],
);

/**
 * A phone number, kept in the clear.
 *
 * ITS OWN TABLE, SEPARATED FROM EVERY OTHER CLAIM, and this was a decision rather than a
 * consequence of the number being special. A phone number is the field this directory exists for, it
 * is the field a person reviews by reading, and it is the field whose provenance an auditor will ask
 * about one at a time — "whose number is this and which page said so". Keeping it beside the
 * addresses would have made the one query that matters, "what have we collected that a person has
 * not looked at", a filter over a mixed table.
 *
 * UNMASKED, BY THE DEPLOYMENT'S OWN INSTRUCTION. These are business numbers published by the
 * companies themselves or by directories that list them, they are the product being built, and a
 * masked one is not a deliverable. Nothing in this deployment treats a phone number as a credential:
 * `content-governance.ts` refuses credentials in tool arguments, and a number is not one. The
 * boundary that does apply is a narrower one — the number is written HERE and not into an audit
 * payload, so the trail names `entry_id` and the disclosure a trail reader gets is the id of a row
 * they already have to be entitled to read.
 */
export const directoryPhoneClaims = pgTable(
  "directory_phone_claims",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    /** The number as published, kept verbatim: reformatting it would lose which spelling was seen. */
    phone: text("phone").notNull(),
    /** Digits only, so the same number spelled two ways is one number to a query. */
    phoneNormalized: text("phone_normalized").notNull(),
    phoneType: text("phone_type").notNull().default("unknown"),
    /** Who it belongs to at the company: 销售部, 采购部, the switchboard. */
    label: text("label"),
    snapshotId: text("snapshot_id"),
    sourceUrl: text("source_url"),
    evidenceQuote: text("evidence_quote").notNull(),
    evidenceLocator: text("evidence_locator"),
    extractionMethod: text("extraction_method").notNull().default("model"),
    confidence: real("confidence").notNull().default(0.5),
    verificationStatus: text("verification_status")
      .notNull()
      .default("unverified"),
    /** The human review point. Everything a Bot writes is `pending` until a person decides. */
    reviewStatus: text("review_status").notNull().default("pending"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdByAgent: text("created_by_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("directory_phone_claims_entry_idx").on(table.entryId),
    index("directory_phone_claims_phone_idx").on(table.phoneNormalized),
    // The queue a person actually reads, and the one this feature's value depends on being fast.
    index("directory_phone_claims_review_idx").on(
      table.reviewStatus,
      table.createdAt,
    ),
  ],
);

/**
 * What a person should look at, and why.
 *
 * A QUEUE RATHER THAN A `review_status` COLUMN, because the reason has nowhere else to live. An
 * entry can be pending review for a dozen reasons — a merge below the confidence floor, a
 * contradicted phone number, a credit code that matched two names — and a status column records
 * that somebody should look without recording what at. The reason is what makes the queue readable
 * by the coordinator Bot, which is the thing that has to explain it to a person.
 *
 * `subject_type` and `subject_id` are text and not a polymorphic foreign key, deliberately: the
 * same shape `audit_events` uses, and for the same reason. Postgres has no polymorphic constraint,
 * and a table that pretends otherwise with three nullable columns is a table where two of them are
 * always null and nothing stops a third.
 */
export const directoryReviewQueue = pgTable(
  "directory_review_queue",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason").notNull(),
    /** Higher first. A contradicted phone number outranks a name spelling. */
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("pending"),
    queuedByAgent: text("queued_by_agent"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /*
     * One pending row per subject. Partial rather than plain, because a subject that was queued,
     * decided and queued again is a subject with a history — and the history is the point of the
     * decision table below. Two PENDING rows for one subject is the shape that has no defence: the
     * person decides one of them and the other sits in the queue for ever.
     */
    uniqueIndex("directory_review_queue_pending_key")
      .on(table.subjectType, table.subjectId)
      .where(sql`status = 'pending'`),
    index("directory_review_queue_pending_idx").on(
      table.status,
      table.priority,
      table.queuedAt,
    ),
  ],
);

/**
 * What a person decided, kept for ever.
 *
 * APPEND-ONLY IN SPIRIT AND IN PRACTICE: nothing updates a row here, and a later decision is a
 * later row. The queue row above is what changes state; this is the record of why, and a record
 * that a subsequent decision can edit is not a record. `decided_by` is the person whose run the
 * decision was recorded in — taken from the signed run, never from a tool argument, because a model
 * that could name the reviewer could write somebody else's approval.
 */
export const directoryReviewDecisions = pgTable(
  "directory_review_decisions",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    decision: text("decision").notNull(),
    note: text("note"),
    /** The queue row this closed, when it closed one. Null for a decision made off-queue. */
    queueId: text("queue_id"),
    decidedBy: text("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    index("directory_review_decisions_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.decidedAt,
    ),
    index("directory_review_decisions_decided_by_idx").on(table.decidedBy),
  ],
);
