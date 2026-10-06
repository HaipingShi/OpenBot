# Steel-trade enterprise directory

A team of six Bots that collects and maintains a directory of steel-trade companies, built as an
OpenBot tenant package. What it produces is not a spreadsheet of names — it is a record in which
every field carries the page it came from, the sentence that stated it, when it was read, and who
checked it.

## What it is for, and what makes it different from a scraper

The value is not "more data collected". It is that a claim about a company can be defended
afterwards:

- **Every fact has a quote.** A claim is refused unless it carries the exact words from the page and
  the snapshot they were read from. A model that cannot quote the page has not read it.
- **Two comments disagreeing is represented, not erased.** A phone number found on three pages is one
  number with three sightings; a number two pages disagree about is a contradiction that goes to a
  person.
- **Identity is a fact, not a guess.** A unified social credit code is the merge key, enforced by a
  partial unique index. Without one, a merge is scored from the stored facts and anything ambiguous
  goes to a person rather than being decided by a model.
- **Nothing is collected through a login wall.** Sources behind a sign-in, a CAPTCHA or a paywall are
  recorded and set aside. This team does not enter credentials, does not ask a person to, and does not
  hand the browser over to get past one.

## The team

| Bot | What it owns | Tools it holds |
|---|---|---|
| `steel-directory-coordinator` | Command: splits a task, hands each stage to its specialist, answers the person. The only Bot that may address another. | reads + `record_review_decision` + routines |
| `steel-source-scout` | Finding pages worth reading and registering them as sources. | `read_page`, `record_source`, `mark_source_blocked` |
| `steel-snapshot-crawler` | Reading pages and recording snapshots with a fingerprint. | `read_page`, `record_snapshot`, `mark_source_blocked` |
| `steel-evidence-extractor` | Turning pages into entries, field claims and phone-number claims. | `read_page`, `record_entry`, `record_claim`, `record_phone_claim` |
| `steel-entity-resolver` | Deciding whether two records are one company. | `resolve_entry`, `queue_review` |
| `steel-verification-qa` | Cross-checking, setting confidence, keeping the directory current. | `verify_entry`, `queue_review` |
| **you** | The review queue: duplicates in the ambiguous band, disputed numbers, blocked sources. | the Review Queue channel |

The pipeline is `discover → snapshot → extract → resolve → verify → (a person decides)`.

## Setting it up

1. `TENANT_PACKAGE_DIR=../examples/steel-directory` in `.env`, then restart the stack. The six Bots
   and four channels are seeded on boot.
2. `bun run steel:setup` — registers the capability, offers its fifteen tools, grants them per Bot,
   gives the coordinator its five handoffs, and adds one policy rule. Idempotent: run it again after
   editing anything here.
3. `BOT_HANDOFF_MAX_PER_RUN=6` in `.env`, so one request can reach all five stages. The default of
   three stops a full sweep halfway.

The package ships the skills and the prompts; the script ships the grants. A skill is an instruction
and confers nothing, so until `steel:setup` has run these Bots can talk and cannot collect.

## Using it

In the **Directory Command** channel, ask for something concrete and bounded:

> Find 10 steel trading companies in Tianjin: register the sources, read them, and record what they
> say.

In the **Review Queue** channel, ask what is waiting, then say what to do about each item. Your
decision is recorded against your name — the tool takes the person from the run, never from an
argument, so a Bot cannot approve something on your behalf.

To keep it current, ask the coordinator to set up a weekly refresh. That is a routine, and it fires a
turn at `steel-verification-qa`.

## Where the data is

Six tables, all under `directory_`:

| Table | What a row is |
|---|---|
| `directory_sources` | A page this deployment may read, and whether it can |
| `directory_snapshots` | A page as it was read: fingerprint, status, excerpt |
| `directory_entries` | A company |
| `directory_claims` | One field of one company, with the sentence that stated it |
| `directory_phone_claims` | A phone number, in the clear, with its label and evidence |
| `directory_review_queue` / `directory_review_decisions` | What a person has to decide, and what they decided |

The page text itself is **not** in the database: each Bot keeps what it read in its own workspace, and
the table keeps the fingerprint, the status and a bounded excerpt. That is what makes two runs
comparable without growing the database by the size of the internet.

The numbers are stored unmasked and are the deliverable. They are not a credential and nothing here
treats them as one; what the platform's content governance screens for is API keys, private keys and
authorization headers, and none of that is a phone number. The boundary that does apply is narrower:
the audit trail records that a call happened and which Bot made it, and does not copy the arguments
into the row, so the numbers live in the table built for them and not in the trail.

## Checking up on it

```sql
-- everything collected that a person has not looked at
select entry_id, phone, label, source_url, confidence, created_at
from directory_phone_claims where review_status = 'pending' order by created_at;

-- the numbers a person has vouched for
select entry_id, phone, label from directory_phone_claims where review_status = 'approved';

-- what the team thinks is worth believing, and how strongly
select name, region, credit_code, entry_type, status, review_status, confidence
from directory_entries order by updated_at desc limit 50;

-- why anything was set aside
select url, kind, blocked_reason, blocked_at, notes
from directory_sources where access_status = 'blocked' order by blocked_at desc;

-- who decided what, and when
select subject_type, subject_id, decision, note, decided_by, decided_at
from directory_review_decisions order by decided_at desc;
```

## Boundaries, stated plainly

- **No login-wall bypass, no CAPTCHA solving, no credential entry.** A page that wants an account is
  recorded with the reason and skipped. One policy rule refuses any typing into a field whose label
  reads as a password or a verification code; the rest is the team's instruction, which is why the
  source table carries the reason a page was set aside.
- **A handoff run is headless, and `read_page` is what it reads with.** The frontend-registered
  browser tools exist only while somebody watches a run, so a specialist reached through the
  coordinator's `message_bot` has no screen. What it does have is `read_page`: a server-side tool
  that opens a page through the deployment's own computer gateway — the same headless Chromium, the
  same target guard, policy and audit as a watched run — and returns the readable text together with
  the snapshot fingerprint. What a handoff still cannot do is the interactive part of a browser, and
  this team has no use for that: it does not sign in anywhere.
- **The directory capability is in-process.** It has no host and no credential — the tools run against
  this deployment's own tables — so there is no local service to reach and no URL validation to
  weaken.
- **The review step is real.** A phone number counts as collected when a person approves it, and the
  approval carries their name from the signed run.
- **`knowledge.yaml` in this package declares nothing**, because this team reads web pages rather than
  connected document stores. It is part of the package contract and is validated; nothing acts on it.
