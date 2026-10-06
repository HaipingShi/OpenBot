/**
 * The enterprise directory's own rules, and the shape of the tool surface a Bot is offered.
 *
 * WHAT IS TESTED HERE AND WHAT IS NOT. The store's SQL is exercised against a real Postgres by the
 * integration suites, not here; what belongs in this file is the part that is pure — the
 * normalisation a phone number goes through, the shape of a credit code, the score two names get —
 * plus the transport's own boundary, which is where a model that forgot the evidence is turned away.
 * The store is stubbed for those cases because the rule being checked is the transport's: "quote the
 * page" is a sentence the model reads, and it is written before any query happens.
 */
import { expect, describe, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  callTool,
  listTools,
  useSteelDirectoryReader,
  useSteelDirectoryTools,
} from "../src/plugins/builtin-steel-directory";
import {
  AUTO_MERGE_FLOOR,
  looksLikeCreditCode,
  NAME_FLOOR,
  nameSimilarity,
  nameStem,
  normalizeName,
  normalizePhone,
  phonesMatch,
  REVIEW_MERGE_FLOOR,
  type DirectoryStore,
} from "../src/steel-directory/store";

describe("a company name reduced to what two spellings share", () => {
  test("case, spacing and punctuation do not make two companies", () => {
    // The two spellings the real world writes for one company, and the reason a name lookup that
    // compared the printed strings would create two rows for one firm.
    expect(normalizeName("上海宝钢（集团）有限公司")).toBe(
      normalizeName("上海宝钢(集团)有限公司"),
    );
    expect(normalizeName("Tianjin  Steel  Co., Ltd.")).toBe(
      normalizeName("tianjin steel co ltd"),
    );
    expect(normalizeName("ＡＢＣ　钢铁")).toBe(normalizeName("abc钢铁"));
  });

  test("different names stay different", () => {
    // Nothing here may decide that 上海宝钢 and 河北钢铁 are the same because both contain 钢铁.
    expect(normalizeName("上海宝钢集团有限公司")).not.toBe(
      normalizeName("河北钢铁集团有限公司"),
    );
  });
});

describe("a unified social credit code", () => {
  test("accepts the shape the registry issues", () => {
    expect(looksLikeCreditCode("91310000631695801A")).toBe(true);
    expect(looksLikeCreditCode("91120116MA05W5Q23X")).toBe(true);
  });

  test("refuses anything else, including the letters the alphabet excludes", () => {
    // Eighteen characters that are not a code would otherwise be a merge key, which is how two
    // unrelated companies get fused by one wrong value.
    expect(looksLikeCreditCode("9131000063169580I")).toBe(false); // I is excluded
    expect(looksLikeCreditCode("9131000063169580O")).toBe(false); // O is excluded
    expect(looksLikeCreditCode("91310000631695801")).toBe(false); // seventeen
    expect(looksLikeCreditCode("91310000631695801AB")).toBe(false); // nineteen
    expect(looksLikeCreditCode("not a code at all")).toBe(false);
    expect(looksLikeCreditCode("")).toBe(false);
  });

  test("case is not the caller's problem", () => {
    // A page may print it lower case. The store upper-cases before storing; this is the same check.
    expect(looksLikeCreditCode("91310000631695801a")).toBe(true);
  });
});

describe("a phone number as digits", () => {
  test("the same switchboard spelled three ways is one number", () => {
    // The three spellings a Chinese company's contact page actually uses for one line.
    expect(normalizePhone("021-5886-8888")).toBe("2158868888");
    expect(normalizePhone("+86 21 5886 8888")).toBe("862158868888");
    expect(normalizePhone("(021) 5886 8888")).toBe("2158868888");
  });

  test("a country code is not a different number", () => {
    expect(phonesMatch("862158868888", "2158868888")).toBe(true);
    expect(phonesMatch("+8613800138000", "13800138000")).toBe(true);
  });

  test("a short number does not match the tail of a long one", () => {
    // The extension-versus-number mistake: "8888" is not the same line as "13800138888", and a
    // suffix rule without a length bound would say it was.
    expect(
      phonesMatch(normalizePhone("8888"), normalizePhone("13800138888")),
    ).toBe(false);
    expect(phonesMatch("58868888", "02158868888")).toBe(true);
  });

  test("the trunk prefix is dropped and the digits are kept", () => {
    // The leading 0 is how one dials from inside the country and is not part of the number.
    expect(normalizePhone("0571-88888888")).toBe("57188888888");
    expect(normalizePhone("+86 138 0013 8000")).toBe("8613800138000");
  });
});

describe("how much two names share", () => {
  test("a near-identical name scores high and an unrelated one scores low", () => {
    const same = nameSimilarity(
      normalizeName("上海宝钢集团有限公司"),
      normalizeName("上海宝钢（集团）有限公司"),
    );
    const other = nameSimilarity(
      normalizeName("上海宝钢集团有限公司"),
      normalizeName("河北钢铁集团有限公司"),
    );
    expect(same).toBeGreaterThan(0.9);
    /*
     * BELOW THE REVIEW FLOOR, which is the property that makes the score usable rather than merely
     * ordered. The shared legal form `集团有限公司` is six characters both names have, and counting
     * them gave this pair 0.56 — inside the band sent to a person. Every pair of companies sharing a
     * legal form would have been queued, and a queue of pairs nothing is wrong with is a queue
     * nobody reads.
     */
    expect(other).toBeLessThan(REVIEW_MERGE_FLOOR);
    expect(same).toBeGreaterThan(other);
  });

  test("a shared legal form is not a shared name", () => {
    // Same city, same trade, different firm: `天津钢铁集团` and `天津钢铁贸易集团` are two companies
    // and the legal form must not make them look like one.
    const two = nameSimilarity(
      normalizeName("天津钢铁集团有限公司"),
      normalizeName("天津钢铁贸易集团有限公司"),
    );
    expect(two).toBeLessThan(AUTO_MERGE_FLOOR);
    // One firm spelled with and without its legal form still matches itself.
    expect(
      nameSimilarity(
        normalizeName("天津钢铁集团有限公司"),
        normalizeName("天津钢铁"),
      ),
    ).toBe(1);
  });

  test("identical names score one, and nothing scores nothing", () => {
    expect(nameSimilarity("宝钢", "宝钢")).toBe(1);
    expect(nameSimilarity("", "宝钢")).toBe(0);
  });

  test("two legal forms of one name are one name, which is what makes a merge reachable", () => {
    /*
     * The pair a real directory produces constantly: the association roster writes one legal form
     * and the company's own site writes the other. This scored 71% before the fix — inside the band
     * sent to a person — because one row held a phone number and the other did not, and an axis
     * where only one side has a value was being counted as a disagreement. The ordinary shape of two
     * rows for one company is that the newer knows less, so that bug penalised exactly the pairs
     * that most needed merging.
     */
    expect(
      nameSimilarity(
        "天津宝钢钢铁贸易有限责任公司",
        "天津宝钢钢铁贸易有限公司",
      ),
    ).toBe(1);
    expect(nameStem("天津宝钢钢铁贸易有限责任公司")).toBe(
      nameStem("天津宝钢钢铁贸易有限公司"),
    );
  });

  test("the name floor sits below a legal-form difference and above an unrelated name", () => {
    // Two floors to hold in one place: what the resolver refuses outright, and what it will score.
    // A legal form is stripped before comparison, so the pair above scores 1; a different trade or
    // province does not reach the floor, which is the case that stops a shared switchboard merging
    // two unrelated firms.
    expect(
      nameSimilarity("天津宝钢钢铁贸易有限公司", "天津宝钢物流有限公司"),
    ).toBeLessThan(NAME_FLOOR);
    expect(
      nameSimilarity(
        "天津宝钢钢铁贸易有限责任公司",
        "天津宝钢钢铁贸易有限公司",
      ),
    ).toBeGreaterThan(NAME_FLOOR);
    expect(NAME_FLOOR).toBeLessThan(REVIEW_MERGE_FLOOR);
  });

  test("the two floors are ordered and leave a band for a person", () => {
    // The floors are the rule the resolver enforces, so the ordering between them is load-bearing:
    // reversed, every ambiguous pair would merge unattended.
    expect(REVIEW_MERGE_FLOOR).toBeLessThan(AUTO_MERGE_FLOOR);
    expect(REVIEW_MERGE_FLOOR).toBeGreaterThan(0);
    expect(AUTO_MERGE_FLOOR).toBeLessThanOrEqual(1);
  });
});

describe("the tools a Bot is offered", () => {
  test("lists fifteen, and every write a policy could be written about is named", async () => {
    const tools = await listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "list_claims",
        "list_review_queue",
        "list_sources",
        "mark_source_blocked",
        "queue_review",
        "read_page",
        "record_claim",
        "record_entry",
        "record_phone_claim",
        "record_review_decision",
        "record_snapshot",
        "record_source",
        "resolve_entry",
        "search_entries",
        "verify_entry",
      ].sort(),
    );
  });

  test("every tool describes itself well enough to be used from the description alone", async () => {
    // A one-line description is a tool a model calls wrongly, and the two mistakes that matter here
    // — no quote, no credit code — are ones the description has to prevent rather than the schema.
    for (const tool of await listTools()) {
      expect(tool.description.length).toBeGreaterThan(120);
    }
  });

  test("listing needs no credential and no actor, because there is nothing to authenticate to", async () => {
    const { listNeedsCredential } = await import(
      "../src/plugins/builtin-steel-directory"
    );
    expect(listNeedsCredential).toBe(false);
    // The call site `refreshTools` passes `{url, token}` and never an actor; a list that insisted on
    // one would store zero tools and leave the capability advertising nothing to anybody.
    expect((await listTools()).length).toBeGreaterThan(0);
  });
});

/**
 * A store that records what it was asked to do, so the transport's own refusals can be checked
 * without a database. Every method rejects, because no call should ever reach one.
 */
function refusingStore(): { store: DirectoryStore; calls: string[] } {
  const calls: string[] = [];
  const refuse = (name: string) => async () => {
    calls.push(name);
    throw new Error(`${name} should not have been reached`);
  };
  const store = {
    recordSource: refuse("recordSource"),
    markSourceBlocked: refuse("markSourceBlocked"),
    listSources: refuse("listSources"),
    recordSnapshot: refuse("recordSnapshot"),
    recordEntry: refuse("recordEntry"),
    searchEntries: refuse("searchEntries"),
    recordClaim: refuse("recordClaim"),
    recordPhoneClaim: refuse("recordPhoneClaim"),
    listClaims: refuse("listClaims"),
    resolveEntry: refuse("resolveEntry"),
    verifyEntry: refuse("verifyEntry"),
    queueReview: refuse("queueReview"),
    listReviewQueue: refuse("listReviewQueue"),
    recordReviewDecision: refuse("recordReviewDecision"),
  } as unknown as DirectoryStore;
  return { store, calls };
}

describe("what the transport refuses before any query happens", () => {
  test("a claim with no quote is turned away with a sentence about quoting", async () => {
    const { store, calls } = refusingStore();
    useSteelDirectoryTools(store);
    try {
      const answer = await callTool(
        { url: "builtin://steel-directory", botId: "steel-evidence-extractor" },
        "record_claim",
        { entryId: "ent_1", field: "capacity", value: "1.2 million tonnes" },
      );
      expect(answer.isError).toBe(true);
      // The refusal has to say what to do, not only that something was wrong: a model that reads
      // "required field" retries the same call with a made-up value.
      expect(answer.text.toLowerCase()).toContain("quote");
      expect(calls).toEqual([]);
    } finally {
      useSteelDirectoryTools(null);
    }
  });

  test("a phone claim with no quote is turned away the same way", async () => {
    const { store, calls } = refusingStore();
    useSteelDirectoryTools(store);
    try {
      const answer = await callTool(
        { url: "builtin://steel-directory", botId: "steel-evidence-extractor" },
        "record_phone_claim",
        { entryId: "ent_1", phone: "021-5886-8888" },
      );
      expect(answer.isError).toBe(true);
      expect(answer.text.toLowerCase()).toContain("quote");
      expect(calls).toEqual([]);
    } finally {
      useSteelDirectoryTools(null);
    }
  });

  test("a phone number is not treated as anything to be masked", async () => {
    /*
     * The number is the deliverable and this deployment stores it in the clear. What this checks is
     * that nothing on the way in refuses it for looking like a credential: `content-governance.ts`
     * screens tool arguments for credentials, and a phone number is not one. The stub receives the
     * number unchanged, which is the property — a masking or a refusal here would be the bug.
     */
    const seen: Record<string, unknown>[] = [];
    const stub = {
      ...refusingStore().store,
      recordPhoneClaim: async (input: Record<string, unknown>) => {
        seen.push(input);
        return {
          phoneClaim: { id: "phone_1", confidence: 0.7 },
          duplicate: false,
        };
      },
    } as unknown as DirectoryStore;
    useSteelDirectoryTools(stub);
    try {
      const answer = await callTool(
        { url: "builtin://steel-directory", botId: "steel-evidence-extractor" },
        "record_phone_claim",
        {
          entryId: "ent_1",
          phone: "021-5886-8888",
          evidenceQuote: "联系电话：021-5886-8888",
          label: "总机",
        },
      );
      expect(answer.isError).toBe(false);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.phone).toBe("021-5886-8888");
      expect(seen[0]?.label).toBe("总机");
    } finally {
      useSteelDirectoryTools(null);
    }
  });

  test("a review decision with no attributed person is refused rather than recorded anonymously", async () => {
    const { store, calls } = refusingStore();
    useSteelDirectoryTools(store);
    try {
      const answer = await callTool(
        // No actorId: a run nobody can be attributed to.
        {
          url: "builtin://steel-directory",
          botId: "steel-directory-coordinator",
        },
        "record_review_decision",
        {
          subjectType: "phone_claim",
          subjectId: "phone_1",
          decision: "approve",
        },
      );
      expect(answer.isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      useSteelDirectoryTools(null);
    }
  });

  test("recording a decision passes the run's person, not anything in the arguments", async () => {
    const seen: Record<string, unknown>[] = [];
    const stub = {
      ...refusingStore().store,
      recordReviewDecision: async (input: Record<string, unknown>) => {
        seen.push(input);
        return {
          decision: "approve",
          subjectType: "phone_claim",
          subjectId: "phone_1",
        };
      },
    } as unknown as DirectoryStore;
    useSteelDirectoryTools(stub);
    try {
      await callTool(
        {
          url: "builtin://steel-directory",
          actorId: "dev-local-user",
          botId: "steel-directory-coordinator",
        },
        "record_review_decision",
        {
          subjectType: "phone_claim",
          subjectId: "phone_1",
          decision: "approve",
          // A model that invents this must not be believed, and the schema has no field for it.
          decidedBy: "somebody-else",
        },
      );
      expect(seen[0]?.decidedBy).toBe("dev-local-user");
    } finally {
      useSteelDirectoryTools(null);
    }
  });

  test("nothing is available when the deployment never installed the store", async () => {
    useSteelDirectoryTools(null);
    const answer = await callTool(
      { url: "builtin://steel-directory", botId: "steel-source-scout" },
      "list_sources",
      {},
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("not available");
  });

  test("a tool this capability does not implement is named rather than silently ignored", async () => {
    const { store } = refusingStore();
    useSteelDirectoryTools(store);
    try {
      const answer = await callTool(
        { url: "builtin://steel-directory", botId: "steel-source-scout" },
        "delete_everything",
        {},
      );
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("delete_everything");
    } finally {
      useSteelDirectoryTools(null);
    }
  });
});

describe("read_page, the headless way to open a page", () => {
  const PAGE_TEXT =
    "Example Domain\n\nThis domain is for use in illustrative examples in documents.";

  test("reads through the installed reader and returns a fingerprint of the exact text", async () => {
    /*
     * The fingerprint is computed HERE, from the text the tool is about to return — asserted
     * against the same hash recomputed in the test. That is the property record_snapshot dedupes
     * on: two runs reading the same page must arrive at the same value, and a value the model
     * computed itself is a value the model can invent.
     */
    const seen: { botId: string; actorId: string; url: string }[] = [];
    useSteelDirectoryTools(refusingStore().store);
    useSteelDirectoryReader(async (input) => {
      seen.push(input);
      return {
        url: "https://example.com/",
        title: "Example Domain",
        text: PAGE_TEXT,
        truncated: false,
      };
    });
    try {
      const answer = await callTool(
        {
          url: "builtin://steel-directory",
          botId: "steel-snapshot-crawler",
          actorId: "dev-local-user",
        },
        "read_page",
        { url: "https://example.com/" },
      );
      expect(answer.isError).toBe(false);
      expect(seen).toEqual([
        {
          botId: "steel-snapshot-crawler",
          actorId: "dev-local-user",
          url: "https://example.com/",
        },
      ]);
      expect(answer.text).toContain("Title: Example Domain");
      expect(answer.text).toContain(PAGE_TEXT);
      const fingerprint = answer.text.match(
        /contentFingerprint: ([0-9a-f]{64})/,
      )?.[1];
      expect(fingerprint).toBeDefined();
      expect(fingerprint).toBe(
        createHash("sha256").update(PAGE_TEXT).digest("hex"),
      );
    } finally {
      useSteelDirectoryTools(null);
      useSteelDirectoryReader(null);
    }
  });

  test("without a computer configured it refuses honestly rather than pretending to read", async () => {
    // A deployment with no computer has no browser anywhere. The refusal has to say that, because
    // "error" tells a model to retry and a made-up page tells a person something false.
    useSteelDirectoryTools(refusingStore().store);
    useSteelDirectoryReader(null);
    try {
      const answer = await callTool(
        { url: "builtin://steel-directory", botId: "steel-source-scout" },
        "read_page",
        { url: "https://example.com/" },
      );
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("No computer is configured");
    } finally {
      useSteelDirectoryTools(null);
    }
  });

  test("a call without a URL is a question about which page, not an error", async () => {
    useSteelDirectoryTools(refusingStore().store);
    useSteelDirectoryReader(async () => {
      throw new Error("reader should not be reached");
    });
    try {
      const answer = await callTool(
        { url: "builtin://steel-directory", botId: "steel-source-scout" },
        "read_page",
        {},
      );
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("url");
    } finally {
      useSteelDirectoryTools(null);
      useSteelDirectoryReader(null);
    }
  });
});
