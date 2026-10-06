/**
 * The builtin transport for the enterprise directory: reading pages, and keeping what they said.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER TRANSPORT. There is no vendor and there is no
 * credential. The calls run against this deployment's own tables, so the ACTOR is the
 * authorization — and here the actor is not even consulted, because unlike a routine the directory
 * is not anybody's: it is one shared record of what the team collected, and a fact about a company
 * does not become a different fact depending on who read it. What the actor is used for is
 * attribution: every row records which Bot wrote it, so "who put this in" has an answer.
 *
 * The store arrives through {@link useSteelDirectoryTools} rather than through a constructor, for
 * the reason `builtin-routines.ts` documents at length: `transportFor` resolves a kind to a MODULE,
 * and the registry is built at import time, long before there is a database.
 *
 * THE DESCRIPTIONS ARE THE PRODUCT. A model that writes an entry without a credit code, or a claim
 * without a quote, is a model whose work cannot be audited later — and the difference between this
 * and a scraper is entirely that somebody can come back and check. So the requirements are written
 * into the tool descriptions in full, with the reason, rather than left to a schema a model reads as
 * a formality.
 */
import { createHash } from "node:crypto";
import { cutAtCodeUnits } from "../channels/text";
import {
  DirectoryRefusedError,
  type DirectoryStore,
} from "../steel-directory/store";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

export type SteelDirectoryTools = DirectoryStore;

let installed: SteelDirectoryTools | null = null;

/**
 * Hand this module the store, once, from the place that builds stores.
 *
 * `null` is a supported argument: the suite is one process, so a test that installs a stub has to be
 * able to take it back out again.
 */
export function useSteelDirectoryTools(
  tools: SteelDirectoryTools | null,
): void {
  installed = tools;
}

/**
 * How `read_page` opens a page, installed from the boot the same way.
 *
 * THE READER IS THE COMPUTER GATEWAY, not a raw fetch and not a second browser. The gateway is the
 * one path a page opens through in this deployment: it locates the calling Bot's own computer
 * (headless by default), applies the private-host target guard, evaluates the action policy and
 * writes the audit row. Wiring `read_page` to it is what gives a HEADLESS RUN a browser — the
 * frontend-registered computer tools exist only while somebody watches, and this is the seam that
 * works when nobody does, without creating a second, ungoverned way out to the web.
 *
 * The actor travels with the call, so the trail names whose run did the reading.
 */
export type SteelPageReader = (input: {
  botId: string;
  actorId: string;
  url: string;
}) => Promise<{
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}>;

let reader: SteelPageReader | null = null;

/** Hand this module the page reader, once, from the place that builds the computer gateway. */
export function useSteelDirectoryReader(
  pageReader: SteelPageReader | null,
): void {
  reader = pageReader;
}

/** The queue a person reads, and the shape a review decision has to name. */
const SUBJECT_TYPES = "entry, phone_claim, claim or source";

const TOOLS: readonly McpTool[] = Object.freeze([
  /* ---------------------------------------------------------------- reading */

  {
    name: "read_page",
    description: [
      "Open a page and read it. Returns the page's final URL, its title, its readable text, and the",
      "sha256 fingerprint of that text, ready to pass to record_snapshot.",
      "",
      "THIS WORKS WITHOUT A BROWSER SESSION. Unlike your screen tools, it does not need anybody to be",
      "watching, so it is the way to read a page from a handoff run. It reads as this deployment's",
      "own browser: nobody is signed in anywhere, and a page that wants an account will say so in its",
      "title or text.",
      "",
      "THE ROUTINE AFTER READING: record the source with record_source (once per address), then call",
      "record_snapshot with the fingerprint this tool returns, then keep the text in your workspace",
      "when you have one and extract from it. If the title or text shows a sign-in, a CAPTCHA or a",
      "paywall, do not extract anything from the page: call mark_source_blocked with the reason and",
      "move on. The tool refuses private and internal addresses, the same as your browser does.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The page to read, including https://.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "list_sources",
    description: [
      "List the pages this deployment may read from, with each one's access status.",
      "",
      "`open` means it was read and answered; `blocked` means a Bot set it aside, and the row says why",
      "(a login wall, a CAPTCHA, a subscription, a robots refusal); `unknown` means it was registered",
      "and never opened. A blocked source is not a failure to retry — this deployment does not sign in",
      "as anybody, so a page behind an account stays behind it.",
      "",
      "Filter by `accessStatus` to get the blocked list on its own, which is the list a person needs",
      "when deciding whether to connect something or to leave it out.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        accessStatus: {
          type: "string",
          description: "One of: unknown, open, blocked. Omit for all of them.",
        },
        kind: {
          type: "string",
          description:
            "One of: official_site, park, association, tender, media, directory, other.",
        },
        limit: {
          type: "number",
          description: "How many to list. Default 50, at most 200.",
        },
      },
    },
  },
  {
    name: "search_entries",
    description: [
      "Find companies already in the directory. Search before recording one: a second row for a",
      "company you already hold is the duplicate this whole pipeline exists to avoid.",
      "",
      "`query` matches the name, the normalized name and the unified social credit code. The result",
      "carries each entry's id, which every other tool takes; its credit code, which is the identity",
      "fact; whether a person has reviewed it; and whether it was merged into another company.",
      "",
      "Merged rows are hidden by default. Set `includeMerged` to see them — an entry that shows up",
      "under a name you searched for and does not appear is more confusing than one duplicate.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Part of a name, or a credit code.",
        },
        region: {
          type: "string",
          description: "An exact region to restrict to.",
        },
        entryType: {
          type: "string",
          description:
            "One of: producer, processor, trader, buyer, logistics, service, unknown.",
        },
        status: {
          type: "string",
          description: "One of: candidate, active, dormant, merged, rejected.",
        },
        reviewStatus: {
          type: "string",
          description: "One of: unreviewed, pending, approved, rejected.",
        },
        includeMerged: {
          type: "boolean",
          description: "True to include rows merged into another company.",
        },
        limit: { type: "number", description: "Default 50, at most 200." },
      },
    },
  },
  {
    name: "list_claims",
    description: [
      "Everything recorded about one company, with the evidence each fact came from.",
      "",
      "Answers two lists: the field claims (website, address, legal representative, capacity, whatever",
      "was recorded) and the phone numbers, each with the quote it was read from, the page, the",
      "confidence, and whether a person has reviewed it.",
      "",
      "Use this before writing a new claim, to see whether the fact is already held and whether a",
      "second page agrees or contradicts it. Two sources agreeing is corroboration; two disagreeing",
      "is what the contradiction check is for.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        entryId: {
          type: "string",
          description: "The entry, from search_entries.",
        },
        field: {
          type: "string",
          description:
            "Only the claims for one field, such as `website`. Omit for every field.",
        },
        limit: {
          type: "number",
          description: "Default 50 per list, at most 200.",
        },
      },
      required: ["entryId"],
    },
  },
  {
    name: "list_review_queue",
    description: [
      "What is waiting for a person, highest priority first, each with a sentence saying what it is",
      "and why it was queued.",
      "",
      "This is the human review point and the only way anything gets out of it: the queue is what a",
      "person reads, and `record_review_decision` is what closes an item. Answer a person's question",
      "about the state of the directory with this list rather than with a count.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many to list. Default 50, at most 200.",
        },
      },
    },
  },

  /* -------------------------------------------------------------- collecting */

  {
    name: "record_source",
    description: [
      "Register a page this deployment may read from, before anything is read from it. Call this the",
      "moment you decide a site is worth reading, and call it again for a second page on the same",
      "site: a source is one address, not one company's whole website.",
      "",
      "`kind` is what sort of page it is, and it matters because a directory listing and a company's",
      "own site are different evidence: a name is well evidenced by either, an operating capability",
      "much more by the second. `official_site`, `park` (an industrial park's company list),",
      "`association` (an industry body's roster), `tender` (a procurement notice, which is evidence a",
      "company bids), `media`, `directory` (a third-party aggregator), or `other`.",
      "",
      "Registering an address that is already here refines its row rather than duplicating it, and a",
      "second registration never un-blocks a source a Bot or a person set aside.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full address, including https://.",
        },
        kind: {
          type: "string",
          description:
            "official_site, park, association, tender, media, directory or other.",
        },
        notes: {
          type: "string",
          description:
            "Anything worth remembering about it: which association, what it lists, how it was found.",
        },
      },
      required: ["url", "kind"],
    },
  },
  {
    name: "mark_source_blocked",
    description: [
      "Set a source aside because this deployment may not read it, and say why.",
      "",
      "CALL THIS INSTEAD OF TRYING TO GET PAST IT, and instead of handing the browser to a person.",
      "A page that wants a sign-in, a CAPTCHA, a subscription or an account is a page this deployment",
      "does not read: nobody here is signed in as anybody, entering credentials into it would be",
      "using somebody's account, and a wall not being bypassed is the intended behaviour rather than a",
      "problem to solve. Record the reason, move on to the next source, and mention it in your answer.",
      "",
      "The reason is a closed list — `login_wall`, `captcha`, `paywall`, `robots`, `gone`, `other` —",
      "because the useful question afterwards is how much of this directory sits behind a wall, and",
      "that is a count over this column and nothing else. `robots` is its own reason because a site",
      "that said no in its robots.txt has made a statement about permission, which is different from",
      "a page merely wanting an account.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          description: "The source, from record_source.",
        },
        reason: {
          type: "string",
          description: "login_wall, captcha, paywall, robots, gone or other.",
        },
        note: {
          type: "string",
          description:
            "What was actually on the page: the sign-in prompt, the CAPTCHA, the paywall.",
        },
      },
      required: ["sourceId", "reason"],
    },
  },
  {
    name: "record_snapshot",
    description: [
      "Record that you read a page, with a fingerprint of what it said.",
      "",
      "READ THE PAGE FIRST with the browser, then record it here. `contentFingerprint` is a hash of",
      "the page's text — sha256 in hex, lower case — and it is what makes two runs comparable: the",
      "same page read twice with the same fingerprint answers `duplicate: true`, which is how",
      '"nothing has changed since we last looked" becomes a fact instead of an impression, and why a',
      "re-crawl costs nothing. A page that changed has a different fingerprint and lands as a new",
      "snapshot, which is what lets two contradicting quotes both be traced back.",
      "",
      "The full text is NOT stored here. Keep it in your own workspace, where a later run can find it;",
      "the row keeps the fingerprint, the status, the title and a bounded excerpt.",
      "",
      "Record a snapshot even when the page turned out to be unusable: `blockedReason` on the snapshot",
      "says the page was reached and what stopped it, which is different from never having looked.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          description: "The source, from record_source.",
        },
        url: {
          type: "string",
          description:
            "The exact page read, which is often deeper than the source.",
        },
        contentFingerprint: {
          type: "string",
          description: "sha256 of the page text, hex, lower case.",
        },
        httpStatus: {
          type: "number",
          description: "The HTTP status, when known.",
        },
        title: { type: "string", description: "The page's title." },
        excerpt: {
          type: "string",
          description:
            "A short window of the page's text, so a quote in a claim can be checked against its context.",
        },
        blockedReason: {
          type: "string",
          description:
            "Set when the page could not be used: login_wall, captcha, paywall, robots, gone or other.",
        },
      },
      required: ["sourceId", "url", "contentFingerprint"],
    },
  },

  /* ---------------------------------------------------------------- judging */

  {
    name: "record_entry",
    description: [
      "Record a company, or refine the one already held.",
      "",
      "SEARCH FIRST with search_entries. This tool does that check itself and will not create a second",
      "row for a name it already holds — it refines the existing one and tells you it did, which is",
      "the difference between a directory and a pile of duplicates.",
      "",
      "THE CREDIT CODE IS THE IDENTITY. If the page states a unified social credit code, pass it: it",
      "is eighteen characters, digits and upper-case letters, and a company with one is known rather",
      "than guessed at. Two rows can never hold the same one. A code that does not match the shape is",
      "refused rather than stored, because a wrong identity fact is worse than a missing one.",
      "",
      "`entryType` is what the evidence says the company does — `producer`, `processor` (processing or",
      "rolling), `trader`, `buyer`, `logistics`, `service` — and it should be left at `unknown` when",
      "nothing read so far says. A guessed type is a claim nobody can check: record the page's own",
      "words as a claim with record_claim, and let the type follow from them.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The company's name as the page writes it.",
        },
        creditCode: {
          type: "string",
          description:
            "The unified social credit code, if the page states one.",
        },
        shortName: {
          type: "string",
          description: "The short name the trade uses.",
        },
        region: { type: "string", description: "Province or city." },
        entryType: {
          type: "string",
          description:
            "producer, processor, trader, buyer, logistics, service or unknown.",
        },
        website: { type: "string", description: "The company's own site." },
        address: {
          type: "string",
          description: "The registered or business address.",
        },
        legalRepresentative: {
          type: "string",
          description: "The legal representative, when a page states one.",
        },
        confidence: {
          type: "number",
          description:
            "0 to 1: how sure you are this row is one real company. Below 0.8 it will need a person.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "record_claim",
    description: [
      "Record one field of one company, as one page stated it, with the words that said it.",
      "",
      "EVIDENCE IS REQUIRED AND IS NOT OPTIONAL. `evidenceQuote` is the sentence on the page that says",
      "this — quote it exactly, as it is written, not a summary of it. `snapshotId` is the page you",
      "read it on, from record_snapshot. A claim without a quote is an assertion nobody can check, and",
      "this store refuses it: if you cannot quote the page, you have not read the page well enough to",
      "record anything from it.",
      "",
      "THE VALUE IS WHAT THE PAGE SAYS, not what you conclude from it. A capacity stated as",
      '"annual output 1.2 million tonnes" is recorded with those words; a figure you derived by adding',
      "two other figures is a different thing and belongs to nobody.",
      "",
      "PREFER THE STRUCTURED SOURCE when a page has one. A table, a JSON-LD block or a download link",
      "gives a field per column; reading it as text loses which column a value came from. Say which",
      "with `extractionMethod`: `rule` when you read a structured field, `model` when you read prose.",
      "",
      "A second page stating the same value is a second claim, which is corroboration and is what the",
      "verification step counts. The same value from the same page is recognised and merged rather",
      "than duplicated.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        entryId: {
          type: "string",
          description: "The entry, from record_entry.",
        },
        field: {
          type: "string",
          description:
            "The field name, in lower snake case: website, address, legal_representative, region, capacity, main_products, founded, registered_capital, employees, business_scope, or anything else the page states.",
        },
        value: {
          type: "string",
          description: "The value as the page states it.",
        },
        evidenceQuote: {
          type: "string",
          description:
            "The exact words on the page that state this. Not a summary.",
        },
        snapshotId: {
          type: "string",
          description: "The snapshot this was read from, from record_snapshot.",
        },
        sourceUrl: {
          type: "string",
          description:
            "The page's address. Pass this when there is no snapshot; a claim needs one or the other.",
        },
        evidenceLocator: {
          type: "string",
          description:
            "Where on the page: a table row, a heading, a selector. So a person can find it again.",
        },
        extractionMethod: {
          type: "string",
          description:
            "rule (read from a table or structured data), model (read from prose) or manual.",
        },
        confidence: {
          type: "number",
          description:
            "0 to 1. How sure you are the page means this company and this value.",
        },
      },
      required: ["entryId", "field", "value", "evidenceQuote"],
    },
  },
  {
    name: "record_phone_claim",
    description: [
      "Record a phone number for a company, with the words and the page it was read from.",
      "",
      "A PHONE NUMBER IS THE DELIVERABLE, so this is the tool whose output a person will read line by",
      "line. Write the number exactly as the page prints it, including the area or country code, and",
      "give the quote it came from. A switchboard found on three pages is one number here, with the",
      "strongest quote kept and the confidence raised — repeated sightings make it more believable,",
      "not longer.",
      "",
      "`phoneType` says what kind of line it is (`landline`, `mobile`, `hotline`, `fax`, `unknown`),",
      "and `label` says whose it is at the company: the sales desk, the purchasing desk, the",
      "switchboard. A number with no label is worth less than one with, and the label is usually the",
      "word next to it on the page.",
      "",
      "Every number lands as `pending` review, whatever its confidence, because a person reads the",
      "numbers before they are used. Do not try to talk a number past that step; record it well and",
      "let the review queue speak for itself.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        entryId: {
          type: "string",
          description: "The entry, from record_entry.",
        },
        phone: {
          type: "string",
          description:
            "The number as published, with its area or country code: 021-5886-8888, +86 21 5886 8888.",
        },
        evidenceQuote: {
          type: "string",
          description: "The exact words on the page that give this number.",
        },
        phoneType: {
          type: "string",
          description: "landline, mobile, hotline, fax or unknown.",
        },
        label: {
          type: "string",
          description:
            "Whose it is: 销售部, 采购部, 总机, the switchboard. The word beside the number on the page.",
        },
        snapshotId: {
          type: "string",
          description: "The snapshot this was read from, from record_snapshot.",
        },
        sourceUrl: {
          type: "string",
          description:
            "The page's address. Pass this when there is no snapshot; a phone claim needs one or the other.",
        },
        evidenceLocator: {
          type: "string",
          description:
            "Where on the page it appeared: the contact block, a table row.",
        },
        extractionMethod: {
          type: "string",
          description: "rule, model or manual.",
        },
        confidence: {
          type: "number",
          description:
            "0 to 1. How sure you are this number belongs to this company.",
        },
      },
      required: ["entryId", "phone", "evidenceQuote"],
    },
  },
  {
    name: "resolve_entry",
    description: [
      "Merge one company's row into another's, when they are the same company.",
      "",
      "THE SCORE IS COMPUTED FROM WHAT THE TWO ROWS ALREADY HOLD, so there is no confidence to pass.",
      "Names, short names, region, address, website and phone are compared — and a factor counts only",
      "when both rows have it, because a value one of them lacks is an absence rather than a",
      "disagreement. The credit code, a registry's own key for a legal entity, settles it outright when",
      "both rows carry the same one, whatever else differs.",
      "",
      "WHAT HAPPENS DEPENDS ON THE SCORE, and the answer tells you which:",
      `below ${Math.round(0.72 * 100)}% name agreement it refuses outright — these are two different companies, whatever else they share, and companies in one industrial park share a switchboard;`,
      `below ${Math.round(0.8 * 100)}% overall it refuses and tells you what could be compared;`,
      `between ${Math.round(0.8 * 100)}% and ${Math.round(0.978 * 100)}%, or when the names agree and nothing else could be checked, it queues the pair for a person and tells you the review item's id;`,
      `at or above ${Math.round(0.978 * 100)}% with at least one agreeing fact besides the name, it merges.`,
      "",
      "Do not retry a refusal with the arguments swapped to see whether the other direction works:",
      "the score is symmetric, and a refusal means a person decides, not that another attempt is owed.",
      "What you CAN do is go and collect the fact that settles it — a credit code, a registered address,",
      "a switchboard — and call again.",
      "",
      "Nothing is deleted. The row that loses keeps its name and its id and points at the survivor, so",
      "anything that already referred to it still resolves.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        loserId: {
          type: "string",
          description: "The row to fold in — the duplicate.",
        },
        winnerId: {
          type: "string",
          description: "The row to keep — the company it turns out to be.",
        },
      },
      required: ["loserId", "winnerId"],
    },
  },
  {
    name: "verify_entry",
    description: [
      "Record the outcome of cross-checking one company against its sources.",
      "",
      "`cross_checked` means independent sources agree and the entry is as good as the evidence",
      "supports; `contradicted` means two sources disagree about something that matters, and the",
      "disagreement goes to a person rather than being resolved here; `needs_more_evidence` means not",
      "enough sources have been read yet. Both of the latter queue the entry for review automatically.",
      "",
      'SAY WHAT WAS COMPARED in `note`, naming the sources. "Three pages agree on the name and two on',
      'the phone" is a verification; "looks good" is not, and nobody reading it later can tell what',
      "was or was not checked.",
      "",
      "This does not change an entry's status. A contradiction does not delete a company — that is a",
      "person's decision, which is what the queue row is for.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        entryId: { type: "string", description: "The entry being verified." },
        verification: {
          type: "string",
          description: "cross_checked, contradicted or needs_more_evidence.",
        },
        note: {
          type: "string",
          description: "What was compared, and what agreed or disagreed.",
        },
        confidence: {
          type: "number",
          description: "0 to 1, if the cross-check changes how sure you are.",
        },
      },
      required: ["entryId", "verification"],
    },
  },

  /* ----------------------------------------------------------- the review step */

  {
    name: "queue_review",
    description: [
      "Put something in front of a person, with the reason in one sentence.",
      `\`subjectType\` is what is being looked at — ${SUBJECT_TYPES} — and \`subjectId\` is its id.`,
      "",
      "USE THIS FOR THE THINGS A BOT MUST NOT DECIDE: a possible duplicate in the ambiguous band, a",
      "number two sources disagree about, a company whose credit code matched two names, a source",
      "somebody may want connected. `priority` is 0 to 10 and the queue is read highest first, so a",
      "contradicted number (8) outranks a spelling (2).",
      "",
      "Queueing something twice is harmless — an item already pending is updated rather than",
      "duplicated, and the reason is replaced only by a reason that outranks it.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        subjectType: {
          type: "string",
          description: "entry, phone_claim, claim or source.",
        },
        subjectId: { type: "string", description: "The row's id." },
        reason: {
          type: "string",
          description:
            "What a person has to decide, in one sentence. Name the disagreement, not the check.",
        },
        priority: {
          type: "number",
          description: "0 to 10, highest read first. Default 0.",
        },
      },
      required: ["subjectType", "subjectId", "reason"],
    },
  },
  {
    name: "record_review_decision",
    description: [
      "Record that a person decided a queued item. THIS IS A PERSON'S DECISION, NOT YOURS.",
      "",
      'Call it when the person you are talking to has just said what they want done — "approve that',
      'number", "reject that duplicate" — and never on your own judgement, however obvious the answer',
      "looks. The decision is recorded against them, and a record that says somebody approved",
      "something they never saw is worse than no record at all.",
      "",
      "What the decision then changes depends on what was queued: an approved phone number becomes one",
      "a person has vouched for, an approved company stays, an approved source may be crawled, an",
      "approved claim becomes verified. A rejection stops the thing being read as data. `approve`,",
      "`reject` or `needs_more_evidence` — the last one leaves the item pending and says what is",
      "missing.",
      "",
      "Pass `queueId` when you know it, from list_review_queue. Without it the pending item for that",
      "subject is closed, which is the same item.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        subjectType: {
          type: "string",
          description: "entry, phone_claim, claim or source.",
        },
        subjectId: { type: "string", description: "The row's id." },
        decision: {
          type: "string",
          description: "approve, reject or needs_more_evidence.",
        },
        note: {
          type: "string",
          description:
            "The person's reasoning, or what is missing. Their words, not your summary of them.",
        },
        queueId: {
          type: "string",
          description: "The review item, from list_review_queue.",
        },
      },
      required: ["subjectType", "subjectId", "decision"],
    },
  },
]);

/** The list is static and needs nobody: there is nothing to discover and no credential to hold. */
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Success as a result, with the same visible cap the vendor transports use. */
function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

/** A string argument that was actually given, or nothing. Blank is not a value. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const stamp = (date: Date | null) =>
  date ? date.toISOString().slice(0, 10) : "never";

/**
 * One entry in words, with everything a caller needs to act on it.
 *
 * Written as a line rather than as JSON on purpose: a model reads "id, name, region, code, type,
 * status, reviewed or not" and can pass any of those back, and a person reading the transcript sees
 * a sentence. The fields are named rather than positional so a model cannot count columns wrong.
 */
function entryLine(entry: {
  id: string;
  name: string;
  shortName: string | null;
  creditCode: string | null;
  region: string | null;
  entryType: string;
  status: string;
  reviewStatus: string;
  confidence: number;
  mergedIntoEntryId: string | null;
  lastVerifiedAt: Date | null;
}): string {
  const parts = [
    `${entry.name} — id ${entry.id}`,
    entry.shortName ? `short ${entry.shortName}` : null,
    entry.region ?? "region unknown",
    entry.creditCode ? `code ${entry.creditCode}` : "no credit code",
    entry.entryType,
    entry.status,
    `${entry.reviewStatus} by a person`,
    `confidence ${entry.confidence.toFixed(2)}`,
    `verified ${stamp(entry.lastVerifiedAt)}`,
    entry.mergedIntoEntryId ? `MERGED INTO ${entry.mergedIntoEntryId}` : null,
  ];
  return `- ${parts.filter(Boolean).join(" · ")}`;
}

function sourceLine(source: {
  id: string;
  url: string;
  kind: string;
  accessStatus: string;
  blockedReason: string | null;
  lastCheckedAt: Date | null;
}): string {
  const parts = [
    `${source.url} — id ${source.id}`,
    source.kind,
    source.accessStatus,
    source.blockedReason ? `because ${source.blockedReason}` : null,
    `last checked ${stamp(source.lastCheckedAt)}`,
  ];
  return `- ${parts.filter(Boolean).join(" · ")}`;
}

function claimLine(claim: {
  id: string;
  field: string;
  value: string;
  evidenceQuote: string;
  sourceUrl: string | null;
  confidence: number;
  extractionMethod: string;
  verifiedAt: Date | null;
}): string {
  const parts = [
    `${claim.field}: ${claim.value}`,
    `"${claim.evidenceQuote}"`,
    claim.sourceUrl ?? "source not named",
    claim.extractionMethod,
    `confidence ${claim.confidence.toFixed(2)}`,
    claim.verifiedAt ? `verified ${stamp(claim.verifiedAt)}` : "not verified",
    `id ${claim.id}`,
  ];
  return `- ${parts.join(" · ")}`;
}

function phoneLine(claim: {
  id: string;
  phone: string;
  phoneType: string;
  label: string | null;
  evidenceQuote: string;
  sourceUrl: string | null;
  confidence: number;
  verificationStatus: string;
  reviewStatus: string;
}): string {
  const parts = [
    claim.phone,
    claim.phoneType,
    claim.label ?? "unlabelled",
    `"${claim.evidenceQuote}"`,
    claim.sourceUrl ?? "source not named",
    claim.verificationStatus,
    `${claim.reviewStatus} by a person`,
    `confidence ${claim.confidence.toFixed(2)}`,
    `id ${claim.id}`,
  ];
  return `- ${parts.join(" · ")}`;
}

/**
 * Call one tool.
 *
 * WHOSE RUN THIS IS COMES FROM THE CONNECTION, NEVER FROM `args`. There is no field for a Bot id in
 * any schema above, so a model that invents one is ignored: `createdByAgent` and `queuedByAgent` are
 * `connection.botId`, and `decidedBy` is `connection.actorId` — the person whose turn it is, taken
 * from the signed run. A model that could name the reviewer could write somebody's approval for
 * something they never saw, which is the one thing the review step exists to prevent.
 *
 * Nothing thrown escapes: a refusal from the store is carried through verbatim, because its sentence
 * is the one a model can act on. These come back as `isError` results, which is what the vendor
 * transports do and what `plugins/tools.ts` expects.
 */
export async function callTool(
  connection: { url: string; token?: string; actorId?: string; botId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const botId = connection.botId?.trim() ?? "";
  const tools = installed;
  if (!tools) {
    return failure(
      "The enterprise directory is not available in this deployment.",
    );
  }

  try {
    switch (toolName) {
      case "read_page": {
        const url = stringArg(args, "url");
        if (!url) return failure("Which page? Pass its full url.");
        /*
         * The reader, not the store, is the dependency here — and its absence is the honest state
         * of a deployment with no computer configured, said plainly rather than as a vague error.
         * The Bot id and the actor travel from the connection so the gateway's audit row names
         * whose run opened the page; nothing in the arguments can supply either.
         */
        if (!reader) {
          return failure(
            "No computer is configured in this deployment, so there is no browser to read pages with.",
          );
        }
        const page = await reader({
          botId,
          actorId: connection.actorId?.trim() ?? "",
          url,
        });
        // Hashed HERE rather than asked of the model: a fingerprint the model computes is a
        // fingerprint the model can invent, and the whole value of `record_snapshot` is that two
        // runs reading the same page arrive at the same value. The hash of the exact text this
        // tool returned is the one string that makes that true.
        const fingerprint = createHash("sha256")
          .update(page.text)
          .digest("hex");
        const header = [
          `Title: ${page.title || "(untitled)"}`,
          `URL: ${page.url}`,
          `Truncated: ${page.truncated ? "yes" : "no"}`,
          `contentFingerprint: ${fingerprint}`,
          "",
        ].join("\n");
        return asResult(
          `${header}${page.text}\n\n[End of page. Pass the contentFingerprint above to record_snapshot, quote the exact words when you record a claim, and mark_source_blocked instead if this page was a sign-in, a CAPTCHA or a paywall.]`,
        );
      }

      case "list_sources": {
        const sources = await tools.listSources({
          accessStatus: args.accessStatus,
          kind: args.kind,
          limit: args.limit,
        });
        if (sources.length === 0) {
          return asResult(
            "No sources are registered yet. Find some with the browser and register each one with record_source.",
          );
        }
        return asResult(sources.map(sourceLine).join("\n"));
      }

      case "search_entries": {
        const entries = await tools.searchEntries({
          query: args.query,
          region: args.region,
          entryType: args.entryType,
          status: args.status,
          reviewStatus: args.reviewStatus,
          includeMerged: args.includeMerged,
          limit: args.limit,
        });
        if (entries.length === 0) {
          return asResult(
            "No companies match. Nothing has been recorded under that name — record it with record_entry once you have read a page that states it.",
          );
        }
        return asResult(entries.map(entryLine).join("\n"));
      }

      case "list_claims": {
        const entryId = stringArg(args, "entryId");
        if (!entryId) {
          return failure(
            "Which company? Pass the entryId from search_entries.",
          );
        }
        const { claims, phones } = await tools.listClaims({
          entryId,
          field: args.field,
          limit: args.limit,
        });
        if (claims.length === 0 && phones.length === 0) {
          return asResult(
            `Nothing is recorded about ${entryId} yet beyond the row itself. Read a page about it and record what it says.`,
          );
        }
        const sections = [];
        if (claims.length > 0) {
          sections.push(`Fields:\n${claims.map(claimLine).join("\n")}`);
        }
        if (phones.length > 0) {
          sections.push(`Phone numbers:\n${phones.map(phoneLine).join("\n")}`);
        }
        return asResult(sections.join("\n\n"));
      }

      case "list_review_queue": {
        const items = await tools.listReviewQueue({ limit: args.limit });
        if (items.length === 0) {
          return asResult(
            "Nothing is waiting for a person. The queue is empty.",
          );
        }
        return asResult(
          items
            .map(
              ({ item, subject }) =>
                `- [${item.priority}] ${subject} — ${item.reason} (${item.subjectType} ${item.subjectId}, queue item ${item.id}, queued ${stamp(item.queuedAt)} by ${item.queuedByAgent ?? "unknown"})`,
            )
            .join("\n"),
        );
      }

      case "record_source": {
        const url = stringArg(args, "url");
        if (!url) return failure("Which page? Pass its full url.");
        const kind = stringArg(args, "kind");
        if (!kind) {
          return failure(
            "What sort of page is it? Pass kind: official_site, park, association, tender, media, directory or other.",
          );
        }
        const { source, created } = await tools.recordSource({
          url,
          kind,
          notes: args.notes,
          agentId: botId,
        });
        return asResult(
          created
            ? `Registered ${source.url} as ${source.kind} — source id ${source.id}. Snapshot a page from it with record_snapshot before recording anything it says.`
            : `${source.url} was already registered as ${source.kind} — source id ${source.id}, currently ${source.accessStatus}. Its row was refined; nothing else changed.`,
        );
      }

      case "mark_source_blocked": {
        const sourceId = stringArg(args, "sourceId");
        if (!sourceId) return failure("Which source? Pass its sourceId.");
        const reason = stringArg(args, "reason");
        if (!reason) {
          return failure(
            "Why is it blocked? Pass reason: login_wall, captcha, paywall, robots, gone or other.",
          );
        }
        const source = await tools.markSourceBlocked({
          sourceId,
          reason,
          note: args.note,
          agentId: botId,
        });
        return asResult(
          `${source.url} is set aside as ${source.accessStatus} (${source.blockedReason}). Move on to another source; do not try to get past it, and do not hand the browser to a person for it. Mention it in your answer.`,
        );
      }

      case "record_snapshot": {
        const sourceId = stringArg(args, "sourceId");
        const url = stringArg(args, "url");
        const contentFingerprint = stringArg(args, "contentFingerprint");
        if (!sourceId) return failure("Which source? Pass its sourceId.");
        if (!url)
          return failure("Which page did you read? Pass its exact url.");
        if (!contentFingerprint) {
          return failure(
            "Pass contentFingerprint: sha256 of the page's text, in hex.",
          );
        }
        const { snapshot, duplicate } = await tools.recordSnapshot({
          sourceId,
          url,
          contentFingerprint,
          httpStatus: args.httpStatus,
          title: args.title,
          excerpt: args.excerpt,
          blockedReason: args.blockedReason,
          agentId: botId,
        });
        return asResult(
          duplicate
            ? `This is the page we already hold — snapshot ${snapshot.id}, first read ${stamp(snapshot.fetchedAt)}. Nothing has changed on it. Do not re-record what it says; use the claims already held, or work on another page.`
            : `Snapshot ${snapshot.id} recorded for ${snapshot.url}${snapshot.title ? ` ("${snapshot.title}")` : ""}. Quote it by this id when you call record_claim or record_phone_claim.`,
        );
      }

      case "record_entry": {
        const name = stringArg(args, "name");
        if (!name) return failure("What is the company called? Pass name.");
        const { entry, created, matchedBy } = await tools.recordEntry({
          name,
          creditCode: args.creditCode,
          shortName: args.shortName,
          region: args.region,
          entryType: args.entryType,
          website: args.website,
          address: args.address,
          legalRepresentative: args.legalRepresentative,
          confidence: args.confidence,
          agentId: botId,
        });
        return asResult(
          created
            ? `Recorded ${entry.name} as a new company — id ${entry.id}${entry.creditCode ? `, credit code ${entry.creditCode}` : ", no credit code yet"}. Now record what the pages say about it with record_claim and record_phone_claim.`
            : matchedBy === "credit_code"
              ? `${entry.name} matches an entry already held on credit code ${entry.creditCode} — id ${entry.id}. Its row was refined. Record claims against that id.`
              : `${entry.name} matches an entry already held by name — id ${entry.id}. Its row was refined. If this is a different company that happens to be spelled the same way, the two rows need a person: queue_review it, or find a credit code that tells them apart.`,
        );
      }

      case "record_claim": {
        const entryId = stringArg(args, "entryId");
        const field = stringArg(args, "field");
        const value = stringArg(args, "value");
        const evidenceQuote = stringArg(args, "evidenceQuote");
        if (!entryId) return failure("Which company? Pass its entryId.");
        if (!field)
          return failure(
            "Which field? Pass field, such as website or capacity.",
          );
        if (!value) return failure("What does the page say? Pass value.");
        if (!evidenceQuote) {
          return failure(
            "Quote the page. Pass evidenceQuote — the exact words that state this, not a summary. A claim without a quote is refused, because nobody could check it later.",
          );
        }
        const { claim, duplicate } = await tools.recordClaim({
          entryId,
          field,
          value,
          evidenceQuote,
          snapshotId: args.snapshotId,
          sourceUrl: args.sourceUrl,
          evidenceLocator: args.evidenceLocator,
          extractionMethod: args.extractionMethod,
          confidence: args.confidence,
          agentId: botId,
        });
        return asResult(
          duplicate
            ? `${claim.field} was already recorded from that page with that value — claim ${claim.id}, confidence raised to ${claim.confidence.toFixed(2)}. A second page saying the same thing would be new corroboration; this is the same page.`
            : `Recorded ${claim.field} for entry ${claim.entryId} — claim ${claim.id}, confidence ${claim.confidence.toFixed(2)}.`,
        );
      }

      case "record_phone_claim": {
        const entryId = stringArg(args, "entryId");
        const phone = stringArg(args, "phone");
        const evidenceQuote = stringArg(args, "evidenceQuote");
        if (!entryId) return failure("Which company? Pass its entryId.");
        if (!phone)
          return failure("Which number? Pass phone as the page prints it.");
        if (!evidenceQuote) {
          return failure(
            "Quote the page. Pass evidenceQuote — the exact words beside the number, not a summary.",
          );
        }
        const { phoneClaim, duplicate } = await tools.recordPhoneClaim({
          entryId,
          phone,
          evidenceQuote,
          phoneType: args.phoneType,
          label: args.label,
          snapshotId: args.snapshotId,
          sourceUrl: args.sourceUrl,
          evidenceLocator: args.evidenceLocator,
          extractionMethod: args.extractionMethod,
          confidence: args.confidence,
          agentId: botId,
        });
        return asResult(
          duplicate
            ? `${phoneClaim.phone} is already held for this company — phone claim ${phoneClaim.id}, confidence raised to ${phoneClaim.confidence.toFixed(2)}, still pending review. A number seen on several pages is one number; do not record it again.`
            : `Recorded ${phoneClaim.phone}${phoneClaim.label ? ` (${phoneClaim.label})` : ""} — phone claim ${phoneClaim.id}, confidence ${phoneClaim.confidence.toFixed(2)}. It is pending review by a person, which is where every number starts.`,
        );
      }

      case "resolve_entry": {
        const loserId = stringArg(args, "loserId");
        const winnerId = stringArg(args, "winnerId");
        if (!loserId || !winnerId) {
          return failure(
            "Name both rows: loserId (the duplicate to fold in) and winnerId (the one to keep).",
          );
        }
        const result = await tools.resolveEntry({
          loserId,
          winnerId,
          agentId: botId,
        });
        return asResult(result.reason);
      }

      case "verify_entry": {
        const entryId = stringArg(args, "entryId");
        if (!entryId) return failure("Which company? Pass its entryId.");
        const verification = stringArg(args, "verification");
        if (!verification) {
          return failure(
            "What did the cross-check conclude? Pass verification: cross_checked, contradicted or needs_more_evidence.",
          );
        }
        const entry = await tools.verifyEntry({
          entryId,
          verification,
          note: args.note,
          confidence: args.confidence,
          agentId: botId,
        });
        return asResult(
          verification === "cross_checked"
            ? `${entry.name} recorded as cross-checked, verified ${stamp(entry.lastVerifiedAt)}.`
            : verification === "contradicted"
              ? `${entry.name} is recorded as contradicted and a review item was queued for a person. Do not resolve the disagreement yourself and do not change the entry's status.`
              : `${entry.name} is recorded as needing more evidence, and a review item was queued. Find another independent source and read it.`,
        );
      }

      case "queue_review": {
        const subjectType = stringArg(args, "subjectType");
        const subjectId = stringArg(args, "subjectId");
        const reason = stringArg(args, "reason");
        if (!subjectType) {
          return failure(
            "What is being queued? Pass subjectType: entry, phone_claim, claim or source.",
          );
        }
        if (!subjectId) return failure("Pass subjectId: the row's id.");
        if (!reason) {
          return failure(
            "Say what a person has to decide, in one sentence. Pass reason — naming the disagreement rather than the check that found it.",
          );
        }
        const { item, created } = await tools.queueReview({
          subjectType,
          subjectId,
          reason,
          priority: args.priority,
          agentId: botId,
        });
        return asResult(
          created
            ? `Queued for a person at priority ${item.priority}: ${item.reason} (review item ${item.id}). It is not decided until a person decides it.`
            : `This was already waiting for a person; the item was updated rather than duplicated (review item ${item.id}, priority ${item.priority}).`,
        );
      }

      case "record_review_decision": {
        const subjectType = stringArg(args, "subjectType");
        const subjectId = stringArg(args, "subjectId");
        const decision = stringArg(args, "decision");
        if (!subjectType) {
          return failure(
            "Pass subjectType: entry, phone_claim, claim or source.",
          );
        }
        if (!subjectId) return failure("Pass subjectId: the row's id.");
        if (!decision) {
          return failure(
            "Pass decision: approve, reject or needs_more_evidence. Only call this when the person you are talking to has just said which.",
          );
        }
        /*
         * The person, from the run. Empty means this run is not attributed to anybody, and a
         * decision nobody can be named for is not a decision this will record. Said here rather
         * than passed through as an empty string, because the store's own refusal would read
         * "decidedBy is required", which names a field the model never had.
         */
        const decidedBy = connection.actorId?.trim() ?? "";
        if (!decidedBy) {
          return failure(
            "The person this decision belongs to could not be established for this run, so nothing was recorded. Ask them to make the decision in a conversation, where their name is known.",
          );
        }
        const result = await tools.recordReviewDecision({
          subjectType,
          subjectId,
          decision,
          note: args.note,
          queueId: args.queueId,
          decidedBy,
        });
        return asResult(
          `Recorded the person's decision on ${result.subjectType} ${result.subjectId}: ${result.decision}. The decision and their name are in the trail; the record of what it changed is in the review decisions table.`,
        );
      }

      default:
        return failure(
          `${toolName} is not a tool the enterprise directory implements. The stored tool list is out of date; refresh it on the Plugins page.`,
        );
    }
  } catch (error) {
    /*
     * The store's sentence, unchanged and unprefixed. It is written for a model to act on — which
     * field is missing, which floor was not met, which source is not registered — and rewording it
     * here would turn an actionable refusal into a vague one.
     */
    if (error instanceof DirectoryRefusedError) return failure(error.message);
    const message = error instanceof Error ? error.message : String(error);
    return failure(Array.from(message).slice(0, 400).join(""));
  }
}
