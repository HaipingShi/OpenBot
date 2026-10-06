/**
 * The enterprise directory: what was collected, what said so, and who decided to believe it.
 *
 * THE SHAPE OF THIS FILE IS THE SHAPE OF THE PROBLEM. Every write here is a claim with a source
 * attached rather than a field set on a row, because the thing being built is not a spreadsheet — it
 * is a set of statements about outside companies, each of which somebody will later have to defend.
 * A phone number without a page it came from is an assertion, and the entire difference between this
 * and a scraper is that the page is stored beside it.
 *
 * FOUR RULES, ENFORCED HERE RATHER THAN ASKED FOR IN A PROMPT:
 *
 *  1. NOTHING IS RECORDED WITHOUT EVIDENCE. A claim carries the words that said it; a snapshot
 *     carries a fingerprint of the page; a phone claim carries both. A model that cannot quote the
 *     page has not read the page, and the store refuses rather than storing a guess.
 *  2. THE CREDIT CODE IDENTIFIES A COMPANY. Where one is present it is the merge key, and a partial
 *     unique index in the database says two rows may not hold the same one. Names are how a company
 *     is found; codes are how it is known.
 *  3. A MERGE BELOW CERTAINTY GOES TO A PERSON. `resolve_entry` computes the score itself from stored
 *     values rather than trusting a number a model typed, merges at or above the floor, refuses
 *     below it, and sends the ambiguous middle to the review queue.
 *  4. A HUMAN DECISION IS ATTRIBUTED TO THE PERSON, NEVER TO THE MODEL. `decided_by` is the run's
 *     actor; there is no field for it in any tool.
 */
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  directoryClaims,
  directoryEntries,
  directoryPhoneClaims,
  directoryReviewDecisions,
  directoryReviewQueue,
  directorySnapshots,
  directorySources,
} from "../db/schema";

/**
 * A sentence a model can act on, carried through the transport unchanged.
 *
 * The same contract `RoutineRefusedError` has and for the same reason: "that source is not
 * registered, register it with record_source first" tells a model what to do next, and "invalid
 * input" does not. It reaches the model as an `isError` result rather than a throw, so an agent turn
 * survives it.
 */
export class DirectoryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryRefusedError";
  }
}

export const SOURCE_KINDS = [
  "official_site",
  "park",
  "association",
  "tender",
  "media",
  "directory",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const BLOCKED_REASONS = [
  "login_wall",
  "captcha",
  "paywall",
  "robots",
  "gone",
  "other",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const ENTRY_TYPES = [
  "producer",
  "processor",
  "trader",
  "buyer",
  "logistics",
  "service",
  "unknown",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_STATUSES = [
  "candidate",
  "active",
  "dormant",
  "merged",
  "rejected",
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const REVIEW_STATUSES = [
  "unreviewed",
  "pending",
  "approved",
  "rejected",
] as const;

export const PHONE_TYPES = [
  "landline",
  "mobile",
  "hotline",
  "fax",
  "unknown",
] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

export const EXTRACTION_METHODS = ["rule", "model", "manual"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const VERIFICATIONS = [
  "cross_checked",
  "contradicted",
  "needs_more_evidence",
] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const REVIEW_DECISIONS = [
  "approve",
  "reject",
  "needs_more_evidence",
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * What may be queued for a person.
 *
 * A closed set, because `subject_type` decides which table `record_review_decision` then writes its
 * verdict back to: an entry's review status, a phone claim's, a source's access decision. A value
 * outside this list would be a queue row that nothing can ever close.
 */
export const REVIEW_SUBJECTS = [
  "entry",
  "phone_claim",
  "claim",
  "source",
] as const;
export type ReviewSubject = (typeof REVIEW_SUBJECTS)[number];

/**
 * The merge floors, as numbers rather than as a sentence in a prompt.
 *
 * A model asked to "merge when confident" merges at whatever feels confident that turn. These are
 * the same three bands the team was designed around: at or above the top one the stored facts agree
 * enough that a person would be rubber-stamping, so the merge happens and is recorded; below the
 * bottom one it is a different company; and the middle is exactly the case a person exists for.
 */
export const AUTO_MERGE_FLOOR = 0.978;
export const REVIEW_MERGE_FLOOR = 0.8;
/**
 * Below this, two names are two companies and nothing else about the rows can change it.
 *
 * The floor under the whole scoring scheme. A mean over the facts that could be compared lets
 * agreeing evidence carry a weak name, which is what it should do — two rows that agree on address,
 * website and switchboard are one company even if the name was typed in differently. What it must
 * never do is let a shared switchboard make two genuinely different names into one company, which is
 * the ordinary way a merge goes wrong: a trading firm and a logistics firm in one park share a
 * number, and a subsidiary shares everything with its parent.
 */
export const NAME_FLOOR = 0.72;

/** Caps, so nothing a model writes is a promise about length. */
const MAX_TEXT = 2000;
const MAX_QUOTE = 1000;
const MAX_REASON = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** An id nothing else can collide with, with the row's own kind readable off it in a log. */
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function required(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new DirectoryRefusedError(`${field} is required.`);
  }
  if (text.length > MAX_TEXT) {
    throw new DirectoryRefusedError(
      `${field} is longer than ${MAX_TEXT} characters; send the part that matters.`,
    );
  }
  return text;
}

function optionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback?: T[number],
): T[number] {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (fallback !== undefined) return fallback;
    throw new DirectoryRefusedError(
      `${field} is required and must be one of: ${allowed.join(", ")}.`,
    );
  }
  const found = allowed.find((candidate) => candidate === text);
  if (!found) {
    throw new DirectoryRefusedError(
      `${field} must be one of: ${allowed.join(", ")}. It was "${text}".`,
    );
  }
  return found;
}

function confidenceOf(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new DirectoryRefusedError(
      "confidence must be a number between 0 and 1.",
    );
  }
  return number;
}

function limitOf(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LIST_LIMIT;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new DirectoryRefusedError(
      "limit must be a whole number of one or more.",
    );
  }
  return Math.min(number, MAX_LIST_LIMIT);
}

/**
 * A company name reduced to what two spellings of it share.
 *
 * What is stripped is what differs between a page, a business registry and a person typing: case,
 * whitespace, punctuation and the brackets around a legal form. What is deliberately kept is the
 * Chinese characters themselves, because 上海宝钢 and 宝钢上海 are different names and nothing here
 * should quietly decide they are not — the comparison below is where that judgement belongs, not
 * here.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[()（）[\]【】·,，.。/\\'"“”‘’\-—_&+]/g, "");
}

/**
 * A phone number as digits, so the same number spelled three ways is one number.
 *
 * `+86 21 5886 8888`, `021-5886-8888` and `02158868888` are one switchboard, and a query that
 * treated them as three would report three phones for one company and one phone for three
 * companies. Zero-padded dialling prefixes go: the `0` in `0571...` is how one dials from inside the
 * country and is not part of the number. An international `+` is kept as a leading `+` so
 * `+8613...` and `8613...` stay distinguishable from a bare `8613...` — see {@link phonesMatch}.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const international = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.replace(/^00/, "");
  if (!international) {
    // One leading zero is a domestic trunk prefix. Two would already have been handled above.
    digits = digits.replace(/^0/, "");
  }
  return digits;
}

/** Whether two stored numbers are the same number, allowing for one carrying its country code. */
export function phonesMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  // A suffix comparison, and only for a substantially longer number: "8888" must not match
  // "13800138888", which is the extension-vs-number mistake this rule exists to avoid.
  return longer.length - shorter.length <= 3 && longer.endsWith(shorter);
}

/**
 * Is this a unified social credit code?
 *
 * Eighteen characters from the code's own alphabet: digits and upper-case letters with I, O, S, V
 * and Z excluded because they are the ones a person misreads. Validated because an eighteen-character
 * string in a column that decides merges is a merge key: a page that printed a registration id in the
 * same shape would, unchecked, fuse two unrelated companies. The check is shape-only on purpose —
 * the check digit's algorithm is not a boundary this store can enforce against a page it did not
 * write, and pretending otherwise would refuse correct codes read off a slightly different format.
 */
export function looksLikeCreditCode(value: string): boolean {
  return /^[0-9A-HJ-NPQRTUWXY]{18}$/.test(value.trim().toUpperCase());
}

/**
 * The legal-form words, which carry no distinguishing information and must not count as similarity.
 *
 * THIS IS NOT COSMETIC, AND THE NUMBER IS WHY. `集团有限公司` is six characters that two unrelated
 * Chinese companies very often share, and a bigram comparison that counted them gave
 * 上海宝钢集团有限公司 and 河北钢铁集团有限公司 0.56 — inside the band this deployment sends to a person,
 * and well clear of the 0.8 it refuses below. Every pair of companies sharing a legal form would have
 * been queued for review, and a queue full of pairs nothing is wrong with is a queue nobody reads.
 *
 * Longest first, and applied repeatedly, because the forms nest: `股份有限公司` contains a company
 * form and a share form, and `集团` stands in front of both.
 */
const LEGAL_FORM_WORDS = [
  "股份有限公司",
  "有限责任公司",
  "集团有限公司",
  "股份公司",
  "有限公司",
  "控股集团",
  "集团公司",
  "钢铁集团",
  "集团",
  "控股",
  "coltd",
  "companylimited",
  "company",
  "corporation",
  "holdings",
  "holding",
  "group",
  "limited",
  "inc",
  "llc",
  "ltd",
  "corp",
  "gmbh",
  "plc",
];

/**
 * A name with its legal form removed: what is left is what distinguishes it.
 *
 * Only similarity reads this. The stored `name_normalized` keeps everything, because that column is
 * what an exact lookup compares, and two legal forms are two strings a page may genuinely have
 * printed.
 */
export function nameStem(normalized: string): string {
  let stem = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of LEGAL_FORM_WORDS) {
      if (stem.length > word.length && stem.endsWith(word)) {
        stem = stem.slice(0, stem.length - word.length);
        changed = true;
        break;
      }
    }
  }
  // Nothing but a legal form: there is no stem to compare, so the full string is all there is.
  return stem.length > 0 ? stem : normalized;
}

/**
 * Dice coefficient over character bigrams: how much two names share, 0..1.
 *
 * Bigrams rather than edit distance because the difference being measured is spelling, not
 * structure: 上海宝钢集团有限公司 and 宝钢集团上海有限公司 share most of their bigrams and score high,
 * while the same name under a different province shares almost none once the legal form is out of
 * the way, which is the answer a person would give. Edit distance would rank the second pair close
 * to the first — both are about ten characters with several substitutions — which is backwards.
 *
 * The legal form is removed first, and that removal is the difference between this being usable and
 * this being noise. See {@link nameStem}.
 */
export function nameSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = nameStem(left);
  const b = nameStem(right);
  if (a === b) return 1;
  const bigrams = (value: string) => {
    const set = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const gram = value.slice(index, index + 2);
      set.set(gram, (set.get(gram) ?? 0) + 1);
    }
    return set;
  };
  const leftGram = bigrams(a);
  const rightGram = bigrams(b);
  let overlap = 0;
  for (const [gram, count] of leftGram) {
    overlap += Math.min(count, rightGram.get(gram) ?? 0);
  }
  const total = a.length - 1 + b.length - 1;
  return total <= 0 ? 0 : (2 * overlap) / total;
}

export type SourceRow = typeof directorySources.$inferSelect;
export type EntryRow = typeof directoryEntries.$inferSelect;
export type SnapshotRow = typeof directorySnapshots.$inferSelect;
export type ClaimRow = typeof directoryClaims.$inferSelect;
export type PhoneClaimRow = typeof directoryPhoneClaims.$inferSelect;
export type ReviewQueueRow = typeof directoryReviewQueue.$inferSelect;

export type DirectoryStore = {
  recordSource(input: {
    url: string;
    kind: unknown;
    notes?: unknown;
    agentId: string;
  }): Promise<{ source: SourceRow; created: boolean }>;
  markSourceBlocked(input: {
    sourceId: string;
    reason: unknown;
    note?: unknown;
    agentId: string;
  }): Promise<SourceRow>;
  listSources(input: {
    accessStatus?: unknown;
    kind?: unknown;
    limit?: unknown;
  }): Promise<SourceRow[]>;
  recordSnapshot(input: {
    sourceId: string;
    url: string;
    contentFingerprint: string;
    httpStatus?: unknown;
    title?: unknown;
    excerpt?: unknown;
    blockedReason?: unknown;
    agentId: string;
  }): Promise<{ snapshot: SnapshotRow; duplicate: boolean }>;
  recordEntry(input: {
    name: string;
    creditCode?: unknown;
    shortName?: unknown;
    region?: unknown;
    entryType?: unknown;
    website?: unknown;
    address?: unknown;
    legalRepresentative?: unknown;
    confidence?: unknown;
    agentId: string;
  }): Promise<{
    entry: EntryRow;
    created: boolean;
    matchedBy: "credit_code" | "name" | null;
  }>;
  searchEntries(input: {
    query?: unknown;
    region?: unknown;
    entryType?: unknown;
    status?: unknown;
    reviewStatus?: unknown;
    includeMerged?: unknown;
    limit?: unknown;
  }): Promise<EntryRow[]>;
  recordClaim(input: {
    entryId: string;
    field: string;
    value: string;
    evidenceQuote: string;
    snapshotId?: unknown;
    sourceUrl?: unknown;
    evidenceLocator?: unknown;
    extractionMethod?: unknown;
    confidence?: unknown;
    agentId: string;
  }): Promise<{ claim: ClaimRow; duplicate: boolean }>;
  recordPhoneClaim(input: {
    entryId: string;
    phone: string;
    evidenceQuote: string;
    phoneType?: unknown;
    label?: unknown;
    snapshotId?: unknown;
    sourceUrl?: unknown;
    evidenceLocator?: unknown;
    extractionMethod?: unknown;
    confidence?: unknown;
    agentId: string;
  }): Promise<{ phoneClaim: PhoneClaimRow; duplicate: boolean }>;
  listClaims(input: {
    entryId: string;
    field?: unknown;
    limit?: unknown;
  }): Promise<{ claims: ClaimRow[]; phones: PhoneClaimRow[] }>;
  resolveEntry(input: {
    loserId: string;
    winnerId: string;
    agentId: string;
  }): Promise<{
    merged: boolean;
    score: number;
    factors: Record<string, number>;
    reason: string;
  }>;
  verifyEntry(input: {
    entryId: string;
    verification: unknown;
    note?: unknown;
    confidence?: unknown;
    agentId: string;
  }): Promise<EntryRow>;
  queueReview(input: {
    subjectType: unknown;
    subjectId: string;
    reason: string;
    priority?: unknown;
    agentId: string;
  }): Promise<{ item: ReviewQueueRow; created: boolean }>;
  listReviewQueue(input: { limit?: unknown }): Promise<
    {
      item: ReviewQueueRow;
      /** A one-line description of what is being looked at, so the queue is readable on its own. */
      subject: string;
    }[]
  >;
  recordReviewDecision(input: {
    queueId?: unknown;
    subjectType: unknown;
    subjectId: string;
    decision: unknown;
    note?: unknown;
    /** From the run, never from the arguments. See the module comment, rule 4. */
    decidedBy: string;
  }): Promise<{
    decision: string;
    subjectType: ReviewSubject;
    subjectId: string;
  }>;
};

/**
 * Everything the directory tools act on.
 *
 * One store over one connection, with the database passed in rather than reached for, so a test can
 * hand it a stub and the boot hands it the real thing.
 */
export function createSteelDirectoryStore(database: Database): DirectoryStore {
  /** Resolve an entry, refusing one that has been merged into another. */
  async function liveEntry(
    entryId: string,
    purpose: string,
  ): Promise<EntryRow> {
    const [entry] = await database
      .select()
      .from(directoryEntries)
      .where(eq(directoryEntries.id, entryId))
      .limit(1);
    if (!entry) {
      throw new DirectoryRefusedError(
        `There is no entry ${entryId}. Find it with search_entries, or record it with record_entry first.`,
      );
    }
    if (entry.mergedIntoEntryId) {
      throw new DirectoryRefusedError(
        `${entry.name} was merged into entry ${entry.mergedIntoEntryId}, so ${purpose} belongs on that one. Use ${entry.mergedIntoEntryId}.`,
      );
    }
    return entry;
  }

  /** Look up an entry by credit code, then by exact normalized name. Names are how a company is found. */
  async function findEntry(
    name: string,
    creditCode: string | null,
  ): Promise<{ entry: EntryRow; matchedBy: "credit_code" | "name" } | null> {
    if (creditCode) {
      const [byCode] = await database
        .select()
        .from(directoryEntries)
        .where(eq(directoryEntries.creditCode, creditCode))
        .limit(1);
      if (byCode) return { entry: byCode, matchedBy: "credit_code" };
    }
    const [byName] = await database
      .select()
      .from(directoryEntries)
      .where(eq(directoryEntries.nameNormalized, normalizeName(name)))
      .orderBy(asc(directoryEntries.createdAt))
      .limit(1);
    return byName ? { entry: byName, matchedBy: "name" } : null;
  }

  /**
   * Queue a subject for a person.
   *
   * A LOCAL FUNCTION RATHER THAN A METHOD, because two other methods here call it — a merge in the
   * ambiguous band and a contradicted verification — and a method reaching for its siblings through
   * `this` is a method that stops working the moment the store is destructured, which is exactly
   * what handing it to the transport registry does. The exported shape and this closure are the same
   * function; only the way it is reached differs.
   */
  async function queueReviewItem(input: {
    subjectType: unknown;
    subjectId: string;
    reason: string;
    priority?: unknown;
    agentId: string;
  }): Promise<{ item: ReviewQueueRow; created: boolean }> {
    const type = oneOf(input.subjectType, REVIEW_SUBJECTS, "subjectType");
    const id = required(input.subjectId, "subjectId");
    const why = required(input.reason, "reason");
    if (why.length > MAX_REASON) {
      throw new DirectoryRefusedError(
        `reason is longer than ${MAX_REASON} characters; say what a person has to decide.`,
      );
    }
    let rank = 0;
    if (
      input.priority !== undefined &&
      input.priority !== null &&
      input.priority !== ""
    ) {
      const parsed =
        typeof input.priority === "number"
          ? input.priority
          : Number(input.priority);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
        throw new DirectoryRefusedError(
          "priority is a whole number from 0 to 10.",
        );
      }
      rank = parsed;
    }

    const [existing] = await database
      .select()
      .from(directoryReviewQueue)
      .where(
        and(
          eq(directoryReviewQueue.subjectType, type),
          eq(directoryReviewQueue.subjectId, id),
          eq(directoryReviewQueue.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) {
      /*
       * Already queued is queued. The reason is refreshed only when the new one outranks the old,
       * because the two calls that reach here twice are a re-run of the same check (which should
       * change nothing) and a worse finding about something already waiting (which should be the
       * sentence a person reads). The partial unique index in the schema is what makes this an
       * ordinary update rather than a race.
       */
      const [updated] = await database
        .update(directoryReviewQueue)
        .set({
          ...(rank >= existing.priority ? { reason: why, priority: rank } : {}),
          updatedAt: new Date(),
        })
        .where(eq(directoryReviewQueue.id, existing.id))
        .returning();
      return { item: updated ?? existing, created: false };
    }

    const [created] = await database
      .insert(directoryReviewQueue)
      .values({
        id: newId("review"),
        subjectType: type,
        subjectId: id,
        reason: why,
        priority: rank,
        queuedByAgent: input.agentId,
      })
      .returning();
    if (!created)
      throw new DirectoryRefusedError("The review item could not be stored.");
    return { item: created, created: true };
  }

  return {
    async recordSource({ url, kind, notes, agentId }) {
      const text = required(url, "url");
      let parsed: URL;
      try {
        parsed = new URL(text);
      } catch {
        throw new DirectoryRefusedError(`"${text}" is not a URL.`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new DirectoryRefusedError(
          "A source is a web page, so its URL starts with http:// or https://.",
        );
      }
      const sourceKind = oneOf(kind, SOURCE_KINDS, "kind");

      const [existing] = await database
        .select()
        .from(directorySources)
        .where(eq(directorySources.url, text))
        .limit(1);
      if (existing) {
        /*
         * Registering a page twice refines the row rather than duplicating it, and it never clears a
         * block. A source set aside at a login wall whose second registration unblocked it would
         * silently re-enter the crawl on the strength of a Bot re-typing a URL; only a person or an
         * explicit `mark_source_blocked` reversal moves that state.
         */
        const [updated] = await database
          .update(directorySources)
          .set({
            kind: sourceKind,
            notes: optionalText(notes) ?? existing.notes,
            registeredByAgent: agentId,
            updatedAt: new Date(),
          })
          .where(eq(directorySources.id, existing.id))
          .returning();
        return { source: updated ?? existing, created: false };
      }

      const [created] = await database
        .insert(directorySources)
        .values({
          id: newId("src"),
          url: text,
          host: parsed.hostname.toLowerCase(),
          kind: sourceKind,
          notes: optionalText(notes),
          registeredByAgent: agentId,
        })
        .returning();
      if (!created)
        throw new DirectoryRefusedError("The source could not be stored.");
      return { source: created, created: true };
    },

    async markSourceBlocked({ sourceId, reason, note, agentId }) {
      const id = required(sourceId, "sourceId");
      const blockedReason = oneOf(reason, BLOCKED_REASONS, "reason");
      const [existing] = await database
        .select()
        .from(directorySources)
        .where(eq(directorySources.id, id))
        .limit(1);
      if (!existing) {
        throw new DirectoryRefusedError(
          `There is no source ${id}. Register it with record_source before marking it blocked.`,
        );
      }
      const stamp = new Date();
      const [updated] = await database
        .update(directorySources)
        .set({
          accessStatus: "blocked",
          blockedReason,
          blockedAt: stamp,
          lastCheckedAt: stamp,
          ...(optionalText(note) ? { notes: optionalText(note) } : {}),
          registeredByAgent: agentId,
          updatedAt: stamp,
        })
        .where(eq(directorySources.id, id))
        .returning();
      if (!updated)
        throw new DirectoryRefusedError("The source could not be updated.");
      return updated;
    },

    async listSources({ accessStatus, kind, limit }) {
      const filters = [];
      if (
        accessStatus !== undefined &&
        accessStatus !== null &&
        accessStatus !== ""
      ) {
        filters.push(
          eq(
            directorySources.accessStatus,
            oneOf(
              accessStatus,
              ["unknown", "open", "blocked"] as const,
              "accessStatus",
            ),
          ),
        );
      }
      if (kind !== undefined && kind !== null && kind !== "") {
        filters.push(
          eq(directorySources.kind, oneOf(kind, SOURCE_KINDS, "kind")),
        );
      }
      return database
        .select()
        .from(directorySources)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(
          asc(directorySources.accessStatus),
          desc(directorySources.updatedAt),
        )
        .limit(limitOf(limit));
    },

    async recordSnapshot({
      sourceId,
      url,
      contentFingerprint,
      httpStatus,
      title,
      excerpt,
      blockedReason,
      agentId,
    }) {
      const id = required(sourceId, "sourceId");
      const pageUrl = required(url, "url");
      const fingerprint = required(contentFingerprint, "contentFingerprint");
      if (!/^[0-9a-f]{16,128}$/i.test(fingerprint)) {
        throw new DirectoryRefusedError(
          "contentFingerprint must be the page's hash in hex — sha256 of the body is what this expects, not a description of the page.",
        );
      }
      const [source] = await database
        .select({ id: directorySources.id })
        .from(directorySources)
        .where(eq(directorySources.id, id))
        .limit(1);
      if (!source) {
        throw new DirectoryRefusedError(
          `There is no source ${id}. Register it with record_source before recording a snapshot of it.`,
        );
      }

      const blocked =
        blockedReason === undefined ||
        blockedReason === null ||
        blockedReason === ""
          ? null
          : oneOf(blockedReason, BLOCKED_REASONS, "blockedReason");

      let status: number | null = null;
      if (
        httpStatus !== undefined &&
        httpStatus !== null &&
        httpStatus !== ""
      ) {
        const parsed =
          typeof httpStatus === "number" ? httpStatus : Number(httpStatus);
        if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
          throw new DirectoryRefusedError(
            "httpStatus must be an HTTP status code.",
          );
        }
        status = parsed;
      }

      /*
       * The same page with the same content is the page we already have.
       *
       * This is what makes a re-crawl cheap and, more importantly, what makes "nothing has changed
       * since March" a fact rather than an impression: the second run finds this row, the tool says
       * so, and no claim is written again. A page that changed has a different fingerprint and is
       * stored as a new snapshot, which is what lets two contradicting quotes both be traced.
       */
      const [existing] = await database
        .select()
        .from(directorySnapshots)
        .where(
          and(
            eq(directorySnapshots.url, pageUrl),
            eq(directorySnapshots.contentFingerprint, fingerprint),
          ),
        )
        .limit(1);
      if (existing) return { snapshot: existing, duplicate: true };

      const [created] = await database
        .insert(directorySnapshots)
        .values({
          id: newId("snap"),
          sourceId: id,
          url: pageUrl,
          contentFingerprint: fingerprint.toLowerCase(),
          httpStatus: status,
          title: optionalText(title),
          excerpt: optionalText(excerpt),
          blockedReason: blocked,
          capturedByAgent: agentId,
        })
        .returning();
      if (!created)
        throw new DirectoryRefusedError("The snapshot could not be stored.");

      const stamp = new Date();
      await database
        .update(directorySources)
        .set({ lastCheckedAt: stamp, updatedAt: stamp })
        .where(eq(directorySources.id, id));

      return { snapshot: created, duplicate: false };
    },

    async recordEntry({
      name,
      creditCode,
      shortName,
      region,
      entryType,
      website,
      address,
      legalRepresentative,
      confidence,
      agentId,
    }) {
      const entryName = required(name, "name");
      const code = optionalText(creditCode);
      if (code && !looksLikeCreditCode(code)) {
        throw new DirectoryRefusedError(
          `"${code}" is not a unified social credit code: eighteen characters, digits and upper-case letters, without I, O, S, V or Z.`,
        );
      }
      const normalizedCode = code ? code.toUpperCase() : null;

      const found = await findEntry(entryName, normalizedCode);
      if (found) {
        /*
         * An existing row is refined, never duplicated — and `matchedBy` is returned rather than
         * implied, because the two cases mean different things to the caller. A credit-code match is
         * the same legal entity and the Bot may carry on; a name match is a spelling, and the caller
         * is expected to send the pair through `resolve_entry` rather than assume.
         */
        const [updated] = await database
          .update(directoryEntries)
          .set({
            ...(normalizedCode && !found.entry.creditCode
              ? { creditCode: normalizedCode }
              : {}),
            shortName: optionalText(shortName) ?? found.entry.shortName,
            region: optionalText(region) ?? found.entry.region,
            ...(entryType !== undefined &&
            entryType !== null &&
            entryType !== ""
              ? { entryType: oneOf(entryType, ENTRY_TYPES, "entryType") }
              : {}),
            website: optionalText(website) ?? found.entry.website,
            address: optionalText(address) ?? found.entry.address,
            legalRepresentative:
              optionalText(legalRepresentative) ??
              found.entry.legalRepresentative,
            updatedAt: new Date(),
          })
          .where(eq(directoryEntries.id, found.entry.id))
          .returning();
        return {
          entry: updated ?? found.entry,
          created: false,
          matchedBy: found.matchedBy,
        };
      }

      const [created] = await database
        .insert(directoryEntries)
        .values({
          id: newId("ent"),
          name: entryName,
          nameNormalized: normalizeName(entryName),
          shortName: optionalText(shortName),
          creditCode: normalizedCode,
          region: optionalText(region),
          entryType:
            entryType === undefined || entryType === null || entryType === ""
              ? "unknown"
              : oneOf(entryType, ENTRY_TYPES, "entryType"),
          website: optionalText(website),
          address: optionalText(address),
          legalRepresentative: optionalText(legalRepresentative),
          confidence: confidenceOf(confidence, 0.5),
          createdByAgent: agentId,
        })
        .returning();
      if (!created)
        throw new DirectoryRefusedError("The entry could not be stored.");
      return { entry: created, created: true, matchedBy: null };
    },

    async searchEntries({
      query,
      region,
      entryType,
      status,
      reviewStatus,
      includeMerged,
      limit,
    }) {
      const filters = [];
      const text = optionalText(query);
      if (text) {
        const pattern = `%${text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        filters.push(
          or(
            sql`${directoryEntries.name} ilike ${pattern}`,
            sql`${directoryEntries.nameNormalized} ilike ${pattern}`,
            sql`${directoryEntries.creditCode} ilike ${pattern}`,
          ),
        );
      }
      if (region !== undefined && region !== null && region !== "") {
        filters.push(eq(directoryEntries.region, required(region, "region")));
      }
      if (entryType !== undefined && entryType !== null && entryType !== "") {
        filters.push(
          eq(
            directoryEntries.entryType,
            oneOf(entryType, ENTRY_TYPES, "entryType"),
          ),
        );
      }
      if (status !== undefined && status !== null && status !== "") {
        filters.push(
          eq(directoryEntries.status, oneOf(status, ENTRY_STATUSES, "status")),
        );
      }
      if (
        reviewStatus !== undefined &&
        reviewStatus !== null &&
        reviewStatus !== ""
      ) {
        filters.push(
          eq(
            directoryEntries.reviewStatus,
            oneOf(reviewStatus, REVIEW_STATUSES, "reviewStatus"),
          ),
        );
      }
      /*
       * Merged rows are hidden by default and reachable on request.
       *
       * They are the losers of a merge: still real, still carrying the name somebody might search
       * for, and never the row anybody wants to act on. Hiding them keeps a search result list
       * actionable; the flag exists because "this company shows up under a name I searched for and
       * does not appear" is a worse confusion than a duplicate.
       */
      if (includeMerged !== true) {
        filters.push(isNull(directoryEntries.mergedIntoEntryId));
      }
      return database
        .select()
        .from(directoryEntries)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(directoryEntries.updatedAt))
        .limit(limitOf(limit));
    },

    async recordClaim({
      entryId,
      field,
      value,
      evidenceQuote,
      snapshotId,
      sourceUrl,
      evidenceLocator,
      extractionMethod,
      confidence,
      agentId,
    }) {
      const id = required(entryId, "entryId");
      const entry = await liveEntry(id, "this claim");
      const claimField = required(field, "field");
      const claimValue = required(value, "value");
      const quote = required(evidenceQuote, "evidenceQuote");
      if (quote.length > MAX_QUOTE) {
        throw new DirectoryRefusedError(
          `evidenceQuote is longer than ${MAX_QUOTE} characters. Quote the sentence that says it, not the page.`,
        );
      }
      const snapshot = optionalText(snapshotId);
      const source = optionalText(sourceUrl);
      if (!snapshot && !source) {
        throw new DirectoryRefusedError(
          "A claim needs evidence: pass the snapshotId it was read from, or at least the page's sourceUrl.",
        );
      }
      if (snapshot) {
        const [known] = await database
          .select({ id: directorySnapshots.id, url: directorySnapshots.url })
          .from(directorySnapshots)
          .where(eq(directorySnapshots.id, snapshot))
          .limit(1);
        if (!known) {
          throw new DirectoryRefusedError(
            `There is no snapshot ${snapshot}. Record it with record_snapshot before quoting it.`,
          );
        }
      }

      /*
       * The same sentence from the same page is one claim, not two.
       *
       * Re-running an extraction over an unchanged snapshot that already went through the pipeline
       * used to double every claim, and a claim table where each fact appears twice makes "how many
       * sources agree" answer two when it means one — which is the number the whole verification step
       * reads. A second page quoting the same value is a different row, which is the corroboration
       * that should count.
       */
      const [existing] = await database
        .select()
        .from(directoryClaims)
        .where(
          and(
            eq(directoryClaims.entryId, entry.id),
            eq(directoryClaims.field, claimField),
            eq(directoryClaims.value, claimValue),
            ...(snapshot
              ? [eq(directoryClaims.snapshotId, snapshot)]
              : [eq(directoryClaims.sourceUrl, source ?? "")]),
          ),
        )
        .limit(1);
      if (existing) {
        const [updated] = await database
          .update(directoryClaims)
          .set({
            evidenceQuote: quote,
            evidenceLocator:
              optionalText(evidenceLocator) ?? existing.evidenceLocator,
            confidence: Math.max(
              existing.confidence,
              confidenceOf(confidence, existing.confidence),
            ),
            updatedAt: new Date(),
          })
          .where(eq(directoryClaims.id, existing.id))
          .returning();
        return { claim: updated ?? existing, duplicate: true };
      }

      const [created] = await database
        .insert(directoryClaims)
        .values({
          id: newId("claim"),
          entryId: entry.id,
          field: claimField,
          value: claimValue,
          snapshotId: snapshot,
          sourceUrl: source,
          evidenceQuote: quote,
          evidenceLocator: optionalText(evidenceLocator),
          extractionMethod:
            extractionMethod === undefined ||
            extractionMethod === null ||
            extractionMethod === ""
              ? "model"
              : oneOf(extractionMethod, EXTRACTION_METHODS, "extractionMethod"),
          confidence: confidenceOf(confidence, 0.5),
          createdByAgent: agentId,
        })
        .returning();
      if (!created)
        throw new DirectoryRefusedError("The claim could not be stored.");
      return { claim: created, duplicate: false };
    },

    async recordPhoneClaim({
      entryId,
      phone,
      evidenceQuote,
      phoneType,
      label,
      snapshotId,
      sourceUrl,
      evidenceLocator,
      extractionMethod,
      confidence,
      agentId,
    }) {
      const id = required(entryId, "entryId");
      const entry = await liveEntry(id, "a phone number");
      const asWritten = required(phone, "phone");
      const normalized = normalizePhone(asWritten);
      if (normalized.length < 6 || normalized.length > 20) {
        throw new DirectoryRefusedError(
          `"${asWritten}" does not read as a phone number. Give the digits as published, including the area or country code.`,
        );
      }
      const quote = required(evidenceQuote, "evidenceQuote");
      const snapshot = optionalText(snapshotId);
      const source = optionalText(sourceUrl);
      if (!snapshot && !source) {
        throw new DirectoryRefusedError(
          "A phone number needs evidence: pass the snapshotId it was read from, or at least the page's sourceUrl.",
        );
      }
      if (snapshot) {
        const [known] = await database
          .select({ id: directorySnapshots.id })
          .from(directorySnapshots)
          .where(eq(directorySnapshots.id, snapshot))
          .limit(1);
        if (!known) {
          throw new DirectoryRefusedError(
            `There is no snapshot ${snapshot}. Record it with record_snapshot before quoting it.`,
          );
        }
      }

      /*
       * The same number for the same company is one number, however many pages printed it.
       *
       * A switchboard on the homepage, on the contact page and in a directory listing is one
       * switchboard — and the version a person has to review once, not three times. The duplicate
       * branch keeps the strongest quote and raises the confidence, so repeated sightings make the
       * number more believable rather than longer.
       */
      const held = await database
        .select()
        .from(directoryPhoneClaims)
        .where(eq(directoryPhoneClaims.entryId, entry.id))
        .orderBy(asc(directoryPhoneClaims.createdAt));
      const same = held.find((row) =>
        phonesMatch(row.phoneNormalized, normalized),
      );
      if (same) {
        const [updated] = await database
          .update(directoryPhoneClaims)
          .set({
            evidenceQuote: quote,
            evidenceLocator:
              optionalText(evidenceLocator) ?? same.evidenceLocator,
            snapshotId: snapshot ?? same.snapshotId,
            sourceUrl: source ?? same.sourceUrl,
            confidence: Math.max(
              same.confidence,
              confidenceOf(confidence, same.confidence),
            ),
            updatedAt: new Date(),
          })
          .where(eq(directoryPhoneClaims.id, same.id))
          .returning();
        return { phoneClaim: updated ?? same, duplicate: true };
      }

      const [created] = await database
        .insert(directoryPhoneClaims)
        .values({
          id: newId("phone"),
          entryId: entry.id,
          phone: asWritten,
          phoneNormalized: normalized,
          phoneType:
            phoneType === undefined || phoneType === null || phoneType === ""
              ? "unknown"
              : oneOf(phoneType, PHONE_TYPES, "phoneType"),
          label: optionalText(label),
          snapshotId: snapshot,
          sourceUrl: source,
          evidenceQuote: quote,
          evidenceLocator: optionalText(evidenceLocator),
          extractionMethod:
            extractionMethod === undefined ||
            extractionMethod === null ||
            extractionMethod === ""
              ? "model"
              : oneOf(extractionMethod, EXTRACTION_METHODS, "extractionMethod"),
          confidence: confidenceOf(confidence, 0.5),
          createdByAgent: agentId,
        })
        .returning();
      if (!created) {
        throw new DirectoryRefusedError(
          "The phone number could not be stored.",
        );
      }
      return { phoneClaim: created, duplicate: false };
    },

    async listClaims({ entryId, field, limit }) {
      const id = required(entryId, "entryId");
      /* Deliberately not `liveEntry`: the claims OF a merged row are exactly what somebody checking
         the merge wants to see, and refusing to show them would hide the evidence. */
      const [entry] = await database
        .select({ id: directoryEntries.id })
        .from(directoryEntries)
        .where(eq(directoryEntries.id, id))
        .limit(1);
      if (!entry) {
        throw new DirectoryRefusedError(`There is no entry ${id}.`);
      }
      const wanted = optionalText(field);
      const capped = limitOf(limit);
      const claims = await database
        .select()
        .from(directoryClaims)
        .where(
          wanted
            ? and(
                eq(directoryClaims.entryId, id),
                eq(directoryClaims.field, wanted),
              )
            : eq(directoryClaims.entryId, id),
        )
        .orderBy(asc(directoryClaims.field), desc(directoryClaims.createdAt))
        .limit(capped);
      const phones = await database
        .select()
        .from(directoryPhoneClaims)
        .where(eq(directoryPhoneClaims.entryId, id))
        .orderBy(desc(directoryPhoneClaims.confidence))
        .limit(capped);
      return { claims, phones };
    },

    async resolveEntry({ loserId, winnerId, agentId }) {
      const loser = await liveEntry(required(loserId, "loserId"), "a merge");
      const winner = await liveEntry(required(winnerId, "winnerId"), "a merge");
      if (loser.id === winner.id) {
        throw new DirectoryRefusedError(
          "A company cannot be merged into itself.",
        );
      }

      /*
       * The score is computed HERE, from what the two rows already hold.
       *
       * It was tempting to take a confidence from the caller, and it would have been worthless: a
       * model that wanted two companies merged would type 0.99, and the floor below would then be a
       * rule about typing. Every factor below is a stored value, so the number is a property of the
       * evidence — and a model that wants a merge has to go and collect the facts that earn one.
       *
       * A FACTOR THAT CANNOT BE COMPARED IS NOT A ZERO, and that distinction is the difference
       * between this working and this never merging anything. `null` means the two rows have nothing
       * to compare on that axis, and the score below is the weighted mean over the axes that DO
       * exist. Counting an absent address as disagreement was the bug this replaces: two rows
       * agreeing perfectly on everything they both held scored 0.42 for the name plus 0.08 for the
       * region — 0.50 — so a pair nobody could tell apart was reported as two different companies,
       * and no amount of further collecting could ever have raised it. A deployment that merges
       * nothing looks exactly like a deployment that merges carefully.
       */
      const factors: Record<string, number | null> = {
        name: nameSimilarity(loser.nameNormalized, winner.nameNormalized),
        shortName:
          loser.shortName && winner.shortName
            ? nameSimilarity(
                normalizeName(loser.shortName),
                normalizeName(winner.shortName),
              )
            : null,
        region:
          loser.region && winner.region
            ? loser.region === winner.region
              ? 1
              : 0
            : null,
        address:
          loser.address && winner.address
            ? nameSimilarity(
                normalizeName(loser.address),
                normalizeName(winner.address),
              )
            : null,
        website:
          loser.website && winner.website
            ? (() => {
                try {
                  return new URL(loser.website).hostname.toLowerCase() ===
                    new URL(winner.website).hostname.toLowerCase()
                    ? 1
                    : 0;
                } catch {
                  return null;
                }
              })()
            : null,
        phone: await (async () => {
          const [left, right] = await Promise.all([
            database
              .select({ phone: directoryPhoneClaims.phoneNormalized })
              .from(directoryPhoneClaims)
              .where(eq(directoryPhoneClaims.entryId, loser.id)),
            database
              .select({ phone: directoryPhoneClaims.phoneNormalized })
              .from(directoryPhoneClaims)
              .where(eq(directoryPhoneClaims.entryId, winner.id)),
          ]);
          /*
           * BOTH SIDES HAVE TO HAVE ONE, or there is nothing to compare.
           *
           * The first version of this only handled "neither has a number", so a row with a
           * switchboard compared against a row with none recorded `0` — a disagreement — and the
           * pair scored 71% instead of 100%. That is the same mistake as counting an absent address
           * as a mismatch, arriving on the axis where it does the most damage: the ordinary shape of
           * two rows for one company is that the newer one knows less, so the pair that most needs
           * to merge is exactly the pair this penalised.
           *
           * A number on one side and a DIFFERENT number on the other is still a disagreement, which
           * is the case this keeps: two rows that each hold a switchboard and do not share one are
           * two companies, or one company whose number moved.
           */
          if (left.length === 0 || right.length === 0) return null;
          const shared = left.some((a) =>
            right.some((b) => phonesMatch(a.phone, b.phone)),
          );
          return shared ? 1 : 0;
        })(),
      };

      /*
       * A SHARED CREDIT CODE IS NOT A SCORE, IT IS AN IDENTITY.
       *
       * The code is the registry's own key for a legal entity, so two rows holding one are one
       * company whatever else differs — a moved address, a renamed subsidiary, a website that
       * changed. Scoring it would let a low name similarity veto the one fact that cannot be wrong.
       * The database refuses two rows with the same code anyway, so this branch is reached when the
       * second row was created before the code was known, which is the ordinary way a duplicate
       * starts.
       */
      const sameCode =
        loser.creditCode !== null &&
        winner.creditCode !== null &&
        loser.creditCode === winner.creditCode;

      const weights: Record<string, number> = {
        name: 0.42,
        shortName: 0.14,
        region: 0.08,
        address: 0.1,
        website: 0.06,
        phone: 0.2,
      };
      const comparable = Object.entries(factors).filter(
        (entry): entry is [string, number] => entry[1] !== null,
      );
      const weighed = comparable.reduce(
        (total, [key]) => total + (weights[key] ?? 0),
        0,
      );
      const score = sameCode
        ? 1
        : weighed <= 0
          ? 0
          : comparable.reduce(
              (total, [key, value]) => total + value * (weights[key] ?? 0),
              0,
            ) / weighed;
      /*
       * What the names are worth, kept apart from the score and used to refuse outright.
       *
       * A mean over the comparable factors lets a strong name carry a thin set of corroborating
       * facts, which is right — and it also means two rows whose names are simply different would
       * be judged on whatever else happened to line up. This is the floor under that: a shared
       * switchboard does not make two companies one, and the name is what says so.
       */
      const nameAgreement = factors.name ?? 0;
      /*
       * How many axes OTHER than the name were compared and agreed, which the top floor requires.
       *
       * A name on its own is a strong signal and not a proof: a registry's names are unique within
       * their registration authority, but two rows spelling one name identically can still be a
       * parent and a subsidiary, or a name reused after a company was struck off. Requiring one
       * other fact to have been checked and matched is what turns "the names look the same" into
       * "these are the same company", and it is the reason a pair with nothing else to compare goes
       * to a person instead of merging.
       */
      const corroborating = comparable.filter(
        ([key, value]) => key !== "name" && value >= 0.85,
      ).length;
      const comparedInWords = comparable
        .map(([key, value]) => `${key} ${Math.round(value * 100)}%`)
        .join(", ");

      if (sameCode) {
        // Above every floor, so it falls through to the merge with a reason naming the code.
      } else if (nameAgreement < NAME_FLOOR) {
        throw new DirectoryRefusedError(
          `These are two different companies: "${loser.name}" and "${winner.name}" share ${Math.round(nameAgreement * 100)}% of their names, below the ${Math.round(NAME_FLOOR * 100)}% this deployment treats as possibly the same firm. A shared phone number or address does not make them one — companies in the same park share a switchboard.`,
        );
      } else if (score < REVIEW_MERGE_FLOOR) {
        throw new DirectoryRefusedError(
          `These do not look like the same company: ${loser.name} and ${winner.name} agree on ${Math.round(score * 100)}% of what could be compared (${comparedInWords}). Below ${Math.round(REVIEW_MERGE_FLOOR * 100)}% this is not a merge to make; keep them as two companies, or find a shared credit code that settles it.`,
        );
      } else if (score < AUTO_MERGE_FLOOR || corroborating === 0) {
        const why =
          corroborating === 0
            ? `The names agree (${Math.round(nameAgreement * 100)}%) and nothing else both rows hold could be compared, so nothing stands behind the name yet.`
            : `Agreement ${Math.round(score * 100)}% is below the ${Math.round(AUTO_MERGE_FLOOR * 100)}% this deployment merges on without a person.`;
        const queued = await queueReviewItem({
          subjectType: "entry",
          subjectId: loser.id,
          reason: `Possible duplicate of ${winner.name} (${winner.id}). ${why} Compared: ${comparedInWords}.`,
          priority: 5,
          agentId,
        });
        return {
          merged: false,
          score,
          factors: Object.fromEntries(comparable),
          reason: `Not merged: ${why} ${loser.name} was queued for a person to decide (review item ${queued.item.id}). Do not merge it yourself, and do not swap the two ids and try again — the score is symmetric. What would settle it is a fact both rows can be checked against: a credit code, a registered address, a switchboard.`,
        };
      }

      /*
       * The merge itself: the loser keeps its row and points at the survivor.
       *
       * Nothing is deleted and nothing is moved. Claims and phone numbers stay where they were
       * written, keyed on the row they were read against — moving them would rewrite the record of
       * which page said what about which spelling of the name. Everything that matters reads through
       * the pointer instead, and `search_entries` hides the loser unless asked.
       */
      const stamp = new Date();
      await database
        .update(directoryEntries)
        .set({
          status: "merged",
          mergedIntoEntryId: winner.id,
          reviewStatus: "approved",
          updatedAt: stamp,
        })
        .where(eq(directoryEntries.id, loser.id));

      // The survivor inherits anything the loser knew and it did not, which is the point of merging.
      const [survivor] = await database
        .update(directoryEntries)
        .set({
          shortName: winner.shortName ?? loser.shortName,
          creditCode: winner.creditCode ?? loser.creditCode,
          region: winner.region ?? loser.region,
          address: winner.address ?? loser.address,
          website: winner.website ?? loser.website,
          legalRepresentative:
            winner.legalRepresentative ?? loser.legalRepresentative,
          /*
           * The survivor's type is only replaced when it had none. "Trader" written from a company's
           * own site is a claim somebody read; "unknown" is the absence of one, and letting a merge
           * overwrite the first with the second would lose information while looking like a no-op.
           */
          entryType:
            winner.entryType === "unknown" ? loser.entryType : winner.entryType,
          confidence: Math.max(winner.confidence, score),
          updatedAt: stamp,
        })
        .where(eq(directoryEntries.id, winner.id))
        .returning();

      return {
        merged: true,
        score,
        factors: Object.fromEntries(comparable),
        reason: sameCode
          ? `Merged: both rows carry the unified social credit code ${loser.creditCode}, which is one legal entity. ${loser.name} now points at ${survivor?.name ?? winner.name} (${winner.id}).`
          : `Merged at ${Math.round(score * 100)}% agreement on ${comparedInWords}. ${loser.name} now points at ${survivor?.name ?? winner.name} (${winner.id}). Its claims and numbers stay on its own row and still resolve through that pointer, so nothing that was read has been rewritten.`,
      };
    },

    async verifyEntry({ entryId, verification, note, confidence, agentId }) {
      const entry = await liveEntry(
        required(entryId, "entryId"),
        "a verification",
      );
      const verdict = oneOf(verification, VERIFICATIONS, "verification");
      const stamp = new Date();
      const [updated] = await database
        .update(directoryEntries)
        .set({
          lastVerifiedAt: stamp,
          lastVerifiedByAgent: agentId,
          ...(confidence === undefined ||
          confidence === null ||
          confidence === ""
            ? {}
            : { confidence: confidenceOf(confidence, entry.confidence) }),
          /*
           * A contradiction does not quietly become a status change.
           *
           * The entry keeps whatever status it had — it is still a company somebody recorded — and
           * the disagreement is what goes to a person, as a queue row written below. Setting status
           * here would let a verification pass delete a company from the directory, which is not a
           * decision a Bot makes.
           */
          updatedAt: stamp,
        })
        .where(eq(directoryEntries.id, entry.id))
        .returning();

      if (verdict === "contradicted") {
        const wanted =
          optionalText(note) ?? "Sources disagree about this company.";
        await queueReviewItem({
          subjectType: "entry",
          subjectId: entry.id,
          reason: `Contradicted by a cross-check: ${wanted}`,
          priority: 8,
          agentId,
        });
      }
      if (verdict === "needs_more_evidence") {
        await queueReviewItem({
          subjectType: "entry",
          subjectId: entry.id,
          reason:
            optionalText(note) ??
            "Not enough independent sources agree about this company yet.",
          priority: 3,
          agentId,
        });
      }

      if (!updated)
        throw new DirectoryRefusedError("The entry could not be updated.");
      return updated;
    },

    async queueReview(input) {
      return queueReviewItem(input);
    },

    async listReviewQueue({ limit }) {
      const rows = await database
        .select()
        .from(directoryReviewQueue)
        .where(eq(directoryReviewQueue.status, "pending"))
        .orderBy(
          desc(directoryReviewQueue.priority),
          asc(directoryReviewQueue.queuedAt),
        )
        .limit(limitOf(limit));

      /*
       * Each row is answered with a sentence about what it is, fetched per subject type.
       *
       * The alternative — returning ids and letting the model look each one up — is one tool call
       * per item and a queue whose readability depends on the model choosing to do it. A person
       * asking "what is waiting" gets a list they can decide from. Bounded by the same limit above,
       * so this is a handful of queries and never an unbounded fan-out.
       */
      const described = await Promise.all(
        rows.map(async (item) => {
          let subject = item.subjectId;
          if (item.subjectType === "entry") {
            const [entry] = await database
              .select({
                name: directoryEntries.name,
                creditCode: directoryEntries.creditCode,
                region: directoryEntries.region,
              })
              .from(directoryEntries)
              .where(eq(directoryEntries.id, item.subjectId))
              .limit(1);
            if (entry) {
              subject = `${entry.name}${entry.region ? ` (${entry.region})` : ""}${
                entry.creditCode ? ` — ${entry.creditCode}` : ""
              }`;
            }
          } else if (item.subjectType === "phone_claim") {
            const [phone] = await database
              .select({
                phone: directoryPhoneClaims.phone,
                label: directoryPhoneClaims.label,
                entryId: directoryPhoneClaims.entryId,
              })
              .from(directoryPhoneClaims)
              .where(eq(directoryPhoneClaims.id, item.subjectId))
              .limit(1);
            if (phone) {
              const [entry] = await database
                .select({ name: directoryEntries.name })
                .from(directoryEntries)
                .where(eq(directoryEntries.id, phone.entryId))
                .limit(1);
              subject = `${phone.phone}${phone.label ? ` (${phone.label})` : ""} for ${entry?.name ?? phone.entryId}`;
            }
          } else if (item.subjectType === "source") {
            const [source] = await database
              .select({
                url: directorySources.url,
                accessStatus: directorySources.accessStatus,
                blockedReason: directorySources.blockedReason,
              })
              .from(directorySources)
              .where(eq(directorySources.id, item.subjectId))
              .limit(1);
            if (source) {
              subject = `${source.url} — currently ${source.accessStatus}${
                source.blockedReason ? ` (${source.blockedReason})` : ""
              }`;
            }
          } else {
            const [claim] = await database
              .select({
                field: directoryClaims.field,
                value: directoryClaims.value,
                entryId: directoryClaims.entryId,
              })
              .from(directoryClaims)
              .where(eq(directoryClaims.id, item.subjectId))
              .limit(1);
            if (claim) {
              subject = `${claim.field}: ${claim.value} (entry ${claim.entryId})`;
            }
          }
          return { item, subject };
        }),
      );
      return described;
    },

    async recordReviewDecision({
      queueId,
      subjectType,
      subjectId,
      decision,
      note,
      decidedBy,
    }) {
      const verdict = oneOf(decision, REVIEW_DECISIONS, "decision");
      const type = oneOf(subjectType, REVIEW_SUBJECTS, "subjectType");
      const id = required(subjectId, "subjectId");
      const by = required(decidedBy, "decidedBy");
      const stamp = new Date();

      const [subject] = await database
        .select({ id: directoryReviewQueue.id })
        .from(directoryReviewQueue)
        .where(
          and(
            eq(directoryReviewQueue.subjectType, type),
            eq(directoryReviewQueue.subjectId, id),
            eq(directoryReviewQueue.status, "pending"),
          ),
        )
        .limit(1);
      const linkedQueueId = optionalText(queueId) ?? subject?.id ?? null;
      if (queueId && !subject) {
        throw new DirectoryRefusedError(
          `Review item ${queueId} is not pending for ${type} ${id}. List the queue with list_review_queue and decide one that is.`,
        );
      }

      /*
       * What the decision changes, in the one place that knows what each subject type means.
       *
       * Three tables, three meanings. An approved phone claim is a number a person has read and
       * vouched for, which is the deliverable; an approved entry is a company that stays; an
       * approved source is a page that may be crawled. A rejection that only closed the queue item
       * and left the row untouched would still be read as data by every later query, which is the
       * failure a review step exists to prevent.
       */
      if (verdict === "approve") {
        if (type === "phone_claim") {
          await database
            .update(directoryPhoneClaims)
            .set({
              reviewStatus: "approved",
              reviewedAt: stamp,
              updatedAt: stamp,
            })
            .where(eq(directoryPhoneClaims.id, id));
        } else if (type === "entry") {
          await database
            .update(directoryEntries)
            .set({ reviewStatus: "approved", updatedAt: stamp })
            .where(eq(directoryEntries.id, id));
        } else if (type === "claim") {
          await database
            .update(directoryClaims)
            .set({
              verifiedAt: stamp,
              verifiedByAgent: by,
              confidence: 1,
              updatedAt: stamp,
            })
            .where(eq(directoryClaims.id, id));
        } else {
          await database
            .update(directorySources)
            .set({
              accessStatus: "open",
              blockedReason: null,
              blockedAt: null,
              updatedAt: stamp,
            })
            .where(eq(directorySources.id, id));
        }
      } else if (verdict === "reject") {
        if (type === "phone_claim") {
          await database
            .update(directoryPhoneClaims)
            .set({
              reviewStatus: "rejected",
              reviewedAt: stamp,
              updatedAt: stamp,
            })
            .where(eq(directoryPhoneClaims.id, id));
        } else if (type === "entry") {
          await database
            .update(directoryEntries)
            .set({
              reviewStatus: "rejected",
              status: "rejected",
              updatedAt: stamp,
            })
            .where(eq(directoryEntries.id, id));
        } else if (type === "claim") {
          await database
            .update(directoryClaims)
            .set({ confidence: 0, verifiedByAgent: by, updatedAt: stamp })
            .where(eq(directoryClaims.id, id));
        } else {
          // A rejected source stays blocked whatever it was: the refusal is a person's, and the
          // reason the Bot recorded ("login_wall") is still the true explanation of why.
          await database
            .update(directorySources)
            .set({
              accessStatus: "blocked",
              blockedReason: sql`coalesce(${directorySources.blockedReason}, 'other')`,
              updatedAt: stamp,
            })
            .where(eq(directorySources.id, id));
        }
      } else if (type === "phone_claim") {
        await database
          .update(directoryPhoneClaims)
          .set({ reviewStatus: "pending", reviewedAt: stamp, updatedAt: stamp })
          .where(eq(directoryPhoneClaims.id, id));
      }

      await database.insert(directoryReviewDecisions).values({
        id: newId("decision"),
        subjectType: type,
        subjectId: id,
        decision: verdict,
        note: optionalText(note),
        queueId: linkedQueueId,
        decidedBy: by,
        decidedAt: stamp,
      });

      if (linkedQueueId) {
        await database
          .update(directoryReviewQueue)
          .set({ status: "decided", decidedAt: stamp, updatedAt: stamp })
          .where(
            and(
              eq(directoryReviewQueue.id, linkedQueueId),
              ne(directoryReviewQueue.status, "decided"),
            ),
          );
      }

      return { decision: verdict, subjectType: type, subjectId: id };
    },
  };
}
