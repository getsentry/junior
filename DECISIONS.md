# Walkthroughs: decision record (not a spec)

Status: in discussion. Recorded 2026-11-10 from the design thread with Thomas.
This replaces `walkthrough-technical-notes.md` where they conflict. The
one-structured-call pipeline in that file is superseded (see "Generation").

## Problem

Coding agents produce more code than people can verify. Walls of diff and
prose overload the reviewer. A Walkthrough gives a reviewer with no context
the story of a PR or a stack. The story is the center. Code is the evidence.
The reviewer can ask questions and then go back to the story.

## Product decisions

- Name: **Walkthrough**. Opt-in and on demand. Never automatic.
- Covers one PR or a whole stack. Reviewers review and merge the whole stack.
- Story first: intent, then chapters in a logical order. It is not a commit
  timeline.
- Short prose with `[n]` citations to sources (Sentry, Conversation, code,
  checks). Visuals support the prose. They do not replace it. Two columns
  where it helps: code and explanation, chart and explanation.
- The intent line states the change type first: "This PR fixes a bug where…",
  "This stack adds…".
- Change types drive the chapters: bug fix, feature, refactor, migration,
  performance, mixed. A mixed layer can get a split suggestion.
- Bug fixes: show evidence that the cause is the root cause, not a
  workaround. Show what else the fix affects. The UI never claims "root cause
  proven". The reviewer decides from the evidence.
- Migrations: say why the migration was needed.
- "How we know it works": a proof card with tests and checks.
- After it ships: name the telemetry that would catch a problem, for changes
  whose outcome is unclear until they ship.
- Re-review is additive, like a forward migration: an Update adds items. It
  does not rewrite history. Only decisions whose cited evidence changed are
  reopened. Same rule for new commits on one PR and for changes in a stack.
- Source Conversation link ("Made in") shows only if the viewer can read it.
- Cost shows in the header as plain muted text with a tooltip. No model name.

## Review output

- Reviews post as the user, with the user's GitHub OAuth token, only on
  click. Reason: Junior ignores its own comments, so a bot-posted review
  breaks the fix loop. Approve, Request changes, Comment.
- Prefer review comments over code changes. Change code directly only when the
  reviewer is the PR author (also via Junior).
- Copy is the fallback: text that pastes directly into GitHub's review box.
- One-person review is fine unless the repo rules require more.
  `GET /repos/{o}/{r}/rules/branches/{branch}` returns the rules. On a Junior
  PR the bot is the pusher, so the requester counts as an independent
  approver.

## Generation

- A generation is an **agent Turn**, not one structured model call. The agent
  uses its normal tools: sandbox and `gh` for the diff,
  `readConversationEvent` / `searchConversationEvents` for Conversations,
  browser skills for screenshots.
- New pieces:
  - **`walkthrough` skill**: templates per change type, citation rules, when
    to capture screenshots, a script to drop mechanical files from the diff.
  - **One deferred tool, `submitWalkthrough`** (`exposure: "deferred"`). It
    validates the structured document, returns problems so the agent can fix
    them, and stores the result. One tool is enough: code is cited by
    file and line range at a commit, and validation checks citations against
    the real diff.
- The starting instruction names the source Conversation (when one is
  readable). The agent reads it newest first with `searchConversationEvents`
  (`types: ["message"]`, page back with `before_seq`), and reads tool output
  only when a message points at it. No "event where the PR was opened"
  pointer yet: nothing stores it. Log pages read per run; add the pointer
  (recorded by the GitHub plugin when it opens the PR) only if long
  Conversations need it. Leave memory out.
- Code citations: `{ kind: "code", pr, path, side: "head" | "base", start,
  end }`. The range must fall inside one diff hunk (context lines included).
  Removed code is cited on the base side. Junior stores one excerpt per
  citation, keyed by `codeExcerptId`. `notCovered` is per file. Citing code
  outside the diff (for example, callers) needs file reads at the head
  commit: later.
- Each generation builds on the previous version (lineage). The previous
  version goes into the starting instruction as marked data.
- Hard budget per run: step limit and dollar limit. Record the real cost of
  each run from day one.
- Tools that write to the PR are off, through the existing tool-disabling
  mechanism.

## Context resolution (before the Turn, plugin code, no model)

- PR to Conversations: `junior_code_changes.conversation_ids`. Junior writes
  it, so it can be trusted. Do not parse the PR body footer: anyone with
  write access can edit it.
- Accept an array of Conversation IDs. Usually one.
- Stack: GitHub Stacks API, `GET /repos/{o}/{r}/stacks?pull_request={n}`
  (Junior files its stacks there, `junior-github/src/tools/stack-pull-request.ts`).
  If the repo can't use stacks (404), follow base branches down, as the stack
  tool does. Not checked: whether GitHub returns PRs bottom-first.
- The GitHub plugin owns stack and PR lookup. Core gets
  `{ pullRequests: [{ repo, number, headSha }], conversationIds: string[] }`.
- Core removes Conversations the Walkthrough may not read **before** it
  writes the instruction, so the model never sees a private Conversation ID.

## Access and failure

- Always a new root Conversation for a generation. Public, hidden from lists.
  Not a child Task.
- Public source Conversations are readable. Private ones are not
  (`policies/conversation-access.md`). This applies even to the PR author.
- **No readable Conversation never fails a Walkthrough.** It proceeds from the
  PRs only. The rail says "Made from the PRs only" and never says why. The
  agent does not guess intent.
- Fail when the PR or its diff can't be read.
- A failed stack lookup fails (with retry). Do not silently treat a stacked PR
  as a single PR.

## Flow

1. Click: Walkthrough action on the PR card in the transcript, or on the PR
   row in Linked work.
2. Resolve stack, head commits, Conversations.
3. Cache check: same PRs and commits opens the stored version ($0). Older
   commits make the latest version the parent. A run already in progress is
   joined.
4. Start: version row and Conversation in one transaction. Start the Turn.
   The page shows "Generating…".
5. The agent generates and calls `submitWalkthrough`.
6. Store the document. Mark ready or failed. Failed shows retry, no partial
   output.
7. Read: document, the viewer's answers, `source` checked for each viewer.
8. Questions: always-visible right panel. Implementation open (see below).
9. Review: answers per viewer per version. Post through the user's token.
10. New pushes: no automatic work. The page shows "N new pushes · Update".

## Storage

- Object storage: the document and screenshots, under an opaque key per
  version. `junior_artifacts` is a candidate for screenshots, but its rows
  have a `public` flag and are served from `/public/artifacts`. Check that
  private artifacts stay private before reuse.
- DB, two tables:
  - `junior_walkthrough_versions`: one row per run. `id`, `walkthrough_id`,
    `parent_version_id`, `conversation_id` (unique), `requested_by_user_id`,
    `status`, `snapshot_key` (unique where not failed: cache and run dedupe),
    `code_changes` jsonb (ordered provider, provider id, head commit),
    `code_change_keys` text[] with GIN (lookup by PR),
    `source_conversation_ids`, `storage_key`, `created_at`, `completed_at`.
    No foreign key to `junior_code_changes`, so PRs written by people work.
  - `junior_walkthrough_answers`: PK (`version_id`, `decision_id`,
    `user_id`), `value`, `note`, `updated_at`. New versions read the parent
    chain. Answers are not copied.
- Not stored: cost (read the generation Conversation's `usage_json`),
  posted reviews (GitHub is the truth), comment drafts (browser), "last
  seen" (derived from answers on earlier versions).

## Hiding generation Conversations

- Target: a `walkthrough` conversation kind. Wait: `kind` is nullable until
  the backfill, and #3059 ("Route per-kind behavior through turnBehavior")
  is changing per-kind behavior.
- Today each listing surface writes its own filter
  (`parentConversationId IS NULL` + `quickQuestionAt IS NULL`):
  `api/conversations/list.ts` (2), `api/board/read.ts`,
  `chat/briefs/search.ts`, `chat/agent-invocations/search-top-level.ts`.
- Plan:
  1. A separate PR with no behavior change: one shared listing predicate
     used by all four sites. Land it after #3047 and #2951, which change
     `list.ts`.
  2. The Walkthrough PR adds its condition inside that predicate (exists in
     `junior_walkthrough_versions`).
  3. Later: rewrite the predicate body to use `kind`.
- Also needed, outside listing: skip Brief generation for generation
  Conversations. Add no participants, so there are no unread markers or
  pushes. Run EXPLAIN on the list query with production-sized data.

## Artifacts

- Artifacts are cited evidence that tools produced. The model never invents a
  visual.
- UI PRs: a cheap planning step picks routes, states, and sizes. Before and
  after screenshots against the base and head previews. Accessibility checks
  go into the proof card. No preview: say so in the proof chapter. Sentry
  previews need sign-in (`qa-sentry-frontend` handles it). Use test data
  only.
- Short recordings only for interaction changes.
- Diagrams: the native diagram schema. No Mermaid.
- Explainer videos (narration and Remotion): later, a separate on-demand
  output of the same document for non-reviewers, priced separately.

## Cost

- Target: about $2 per Walkthrough is acceptable. $15 is not. The numbers are
  rough.
- An agent loop costs more than one call. Guess: 2–5× for code-only PRs.
  Measure it.
- Cheap: cache hits, Brief before transcript, mechanical files removed,
  citations not copied code, budget caps.

## In-flight work to watch (open PRs, 2026-11-10)

- #3071 merged: `listedConversation()` is the one listing rule.
- #3059 per-kind behavior table: where the `walkthrough` kind goes later. The
  kind also needs the `kind` backfill and NOT NULL, which has no PR yet.
- #3062: migration lock handling. Take the next free migration number.
- #3052: private Conversations at one Destination can reach each other.
  Re-read `policies/conversation-access.md` after it merges.

## Settled since the first record

- Questions panel: one private Conversation per reviewer, seeded with the
  Walkthrough version and the source Conversation ID (when readable). The
  agent reads the source Conversation, or the public generation Conversation,
  only when a question needs it. A fork would copy the whole generation run.
- Starting from the dashboard works: `createAndEnqueueConversation`
  (`api/conversations/create.ts`) creates a root Conversation and queues the
  first message. The normal mailbox and worker run the Turn. Check: the
  clicker may become a participant of the hidden Conversation.
- Stack and head commits: a new optional, provider-neutral plugin hook that
  the generation route calls before the Turn. The GitHub plugin implements
  it (Stacks API, base-branch fallback, installation read token). Needed for
  the cache check before any model cost.

## Open questions

- Reviews as the user. Today `junior-github/src/egress-policy.ts` sends PR
  reviews and comments with the installation token on purpose, and
  `user-write` is used only for asset uploads. Plugin API routes get no user
  token. Needs: a core contract for an authenticated plugin route to call the
  provider with the viewer's own token, used only on an explicit dashboard
  click, never by the agent. `policies/security.md` allows user-owned access
  for the current actor; the core contract change needs core review.
- Who pays: the person who clicked (proposed).
- Update: on click only (proposed) or prepared ahead on push.
- Default model and the budget numbers.

## Prototype

- Local branch `walkthrough-prototype` in `getsentry/junior`, 10 commits on
  `main`, not pushed. Patch: `walkthrough-prototype.patch`.
- Mock pages: `/walkthroughs/new` (one bug fix PR), `/walkthroughs/demo`
  (stack with Update).
- The schema and validator cite code by PR, file, and line range
  (`packages/junior/src/chat/walkthroughs/`). Still from the one-call design:
  `sources` (Brief facts) and `meta.briefVersion`. They change when the
  skill and `submitWalkthrough` are designed.

## Implementation slices

Each slice is one PR on `main`. Entry points ship in slice 5, so users see
nothing before that.

1. Schema, `validateWalkthrough()` / `validateWalkthroughUpdate()`,
   unified-diff parsing, mechanical-file filter, excerpt building. Citations
   inside the diff and, on the head side, outside it (checked against a file
   read). Unit tests.
2. `codeChanges` hook group in `junior-plugin-api` (`readStack`, `readDiff`,
   `readFile`) plus core wrappers (`pluginFor(provider)`, schema check).
   GitHub implementation: Stacks API, else walk base branches down and up
   (open PRs, stop at trunk, ambiguity, or depth 10), then each PR's details.
   Plugin tests on fake GitHub HTTP, one real-stack check.
3. Storage: `junior_walkthrough_versions`, `junior_walkthrough_answers`
   (pass the #3070 migration check), object storage, store functions,
   `listedConversation()` exclusion.
4a. `walkthrough` skill + deferred `submitWalkthrough` (reads through the
   hooks at the SHAs fixed at click, validates, returns problems, stores).
   Frameshift-style CI reports citable as checks. Run from the CLI on 2-3
   real PRs and record cost. Stop and rethink if far over ~$2.
4b. Generation route: readStack, cache check, hidden Conversation + version
   row, `createAndEnqueueConversation`, budget limits, cost from
   `usage_json`.
5. Dashboard on real data, generating and failed states, entry points on the
   PR card and Linked work.
6. Answers per viewer and version, review text to paste into GitHub.
7. Questions panel: private Conversation per reviewer, seeded.
8. Updates (lineage) and "changed since you looked".
9. Post reviews and approvals as the user. Needs core review of the
   viewer-token contract first.

Later: `walkthrough` kind (#3059 + kind backfill), captured screenshots,
PR-opened event pointer, explainer videos (fframes vs Remotion).

## 2026-11-11 — 4b decisions

- **Generation Conversation visibility: public.** Reads of the source
  Conversation follow normal access: public source → readable; private
  source → skipped, run uses the code changes only. Rejected: private
  generation owned by the clicker (cannot read another private tree under
  `canAccessConversation`), child of the source (would leak private content
  to a clicker who is not a member).
- **Merged layers: skipped** in readStack; the requested layer stays even if
  closed. The whole stack is the review unit, and merged work is done.
- **Cost: from Conversation metrics**, not a column. One source of truth;
  covers every slice of a resumed Turn.

### 2026-11-11 — Update Turn sees change-request decision ids (Thomas)

The update Turn gets the ids of decisions that any reviewer marked "Request
change", and nothing else: no notes, no reviewer. The generation Conversation
is public, so anyone who opens it can see that some reviewer pushed back on
those decisions. Thomas approved this. Notes stay private.

### 2026-11-11 — Story-first chapters (Thomas)

- A Walkthrough synthesizes the whole stack, 1 PR or 10, into one guided
  story. Commits, diffs, and checks are evidence, not structure. The prose
  plus citations must be enough for a reviewer with zero context.
- Chapters are not fixed. The change type suggests a structure (bug fix:
  root cause + proof it is the root cause, the fix, proof it works, side
  effects, what to watch after it ships; feature, migration, and so on differ).
  The agent adapts it: it may skip, merge, reorder, or add chapters when
  the change needs it. The type applies to the whole Walkthrough, not to
  each PR.
- Drop "Brief first, transcript later". The agent reads the source
  Conversation transcript as it sees fit. Don't be prescriptive.
- The generation transcript and its usage breakdown stay reachable from
  the Walkthrough page (link to the generation Conversation).
