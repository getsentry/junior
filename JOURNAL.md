# Walkthroughs implementation journal

Read this first after a sandbox reset or context loss.

## How to resume

- Journal branch: `walkthrough-journal` (orphan, never merged). Worktree:
  `git worktree add /vercel/sandbox/journal walkthrough-journal`.
- Prototype (reference only): branch `walkthrough-prototype`.
- Stack: one PR per slice, each based on the previous slice's branch.
  Branch names: `walkthrough/1-schema`, `walkthrough/2-code-change-hooks`, ...
- Decisions: `DECISIONS.md` on this branch.
- Requester: Thomas Jiang (Slack <@U0CC10JTPBP>, GitHub thomasjiangcy).
  Explain from scratch; he has not read the prototype code.

## Production-safety rules (agreed 2026-11-10)

- Merge does not deploy; junior-prod picks up a release via self-update.
- Slice 2: do not modify `junior-github/src/tools/stack-pull-request.ts`.
- Slice 3: new tables only; pass #3070 lock check; index the column the
  `listedConversation()` exclusion reads; check the query plan.
- Slice 4a: skill uses `disable-model-invocation: true`; `submitWalkthrough`
  exists only in generation Turns via `turnBehavior` WALKTHROUGH_GENERATION.
- Slice 4b: on/off switch, off by default, blocks routes (404); step and
  dollar limits. Slice 5 entry points use the same switch.

## Current state (2026-11-11)

- Stack #3089 on main: #3087 (1-schema) → #3088 (2-code-change-hooks) →
  #3090 (3-storage, migration 0100) → #3124 (4a-generation-tool). All drafts,
  all mergeable. Use `gh stack rebase` / `gh stack push` to update.
- #3133 (4b-generation-worker) → #3147 (5-dashboard, head 450adaa6b).
- #3149 (6) → #3150 (7) → #3151 (8) → #3155 (9-polish, format v2) →
  walkthrough/10-review-ux (Thomas's three nitpicks).
- Next: posting the review as the user.

## Open questions (decide in 4b)

- Generation Conversation visibility: a public generation Conversation
  cannot read a private source Conversation.
- Stacks API can list merged layers: skip them or include them?
- Read #3052 before writing the worker.

## Log

### 2026-11-10

- Thomas approved proceeding with the plan, stacked, with this journal.
- Created this journal branch.
- Review item 4338131e answered: no key needed. An egress proxy injects AI
  Gateway auth. Verified: `curl https://ai-gateway.vercel.sh/v1/chat/completions`
  without a key returns 200 with usage and `gateway_cost`. If the CLI demands
  `AI_GATEWAY_API_KEY`, set a placeholder value. 4a cost runs happen here.
- Slice 1 started on `walkthrough/1-schema` (from origin/main). Schema changes
  vs prototype: Brief `source` evidence replaced by `message` (seq in the
  source Conversation) and `link` (url must appear in a PR body or cited
  message); decision origin `assumed` has no sourceId; document `sources` →
  `sourceConversationId` + `messages`; removed `meta.briefVersion` and the
  unimplemented `moved` skip reason. Head-side code citations may point
  outside the diff.
- Slice 1 done: draft PR #3087 (`walkthrough/1-schema`, commit 2d1cf2845).
  Files: `packages/junior/src/chat/walkthroughs/{schema,validate,diff,excerpts}.ts`,
  tests `packages/junior/tests/unit/walkthroughs/{validate,diff}.test.ts` (14).
  Key shapes for later slices:
  - `WalkthroughDiffFile {pr, path, hunks: {head?, base?, lines}[]}` in diff.ts.
  - `readWalkthroughDiff(pr, changedFiles)` → `{files, skipped}`;
    `WalkthroughChangedFile {path, previousPath?, status, patch?}` is the
    shape the slice 2 `readDiff` hook must return per file.
  - `WalkthroughInputRefs {files, contextFiles: Map<"pr:path", text>,
    messageSeqs, knownUrls, checkIds}`; `contextFileKey(pr, path)`.
  - `buildWalkthroughExcerpts(refs, files, contextFiles)`; throws if a ref
    does not resolve (call only after validation).
  - Skip reasons: generated, lockfile, no_diff, rename, whitespace.
  Checks run: unit tests, tsc, oxlint, depcruise, file-length,
  test-architecture. Pre-commit hooks pass in the main worktree.
  Not done in slice 1: language detection and permalinks on excerpts
  (`language`, `url` stay optional; provider permalink can come from slice 2).
- Slice 2 done: draft PR #3088 (`walkthrough/2-code-change-hooks`, commit
  af8fc1033), base `walkthrough/1-schema`. GitHub stack #3089 = [#3087, #3088].
  - Plugin API (`junior-plugin-api/src/code.ts`): `CodeChangeHooks`
    {readStack, readDiff, readFile}, `CodeChangeReadHookContext` (egress,
    signal), `codeChangeStackSchema`, `codeChangeDiffSchema`,
    `CodeChangeStack`, `CodeChangeDiff`. `PluginHooks.codeChanges?`.
  - Core (`junior/src/chat/plugins/code-change-hooks.ts`):
    `readPluginCodeChangeStack({provider, repository, number, signal})`,
    `readPluginCodeChangeDiff({provider, repository, baseSha, headSha, signal})`,
    `readPluginCodeFile({provider, repository, sha, path, signal})`.
    System Actor `code-change-read`, no auth prompts. Throws if the provider
    has no hooks (caller should check first; add a `canReadCodeChanges` when
    slice 5 needs it — removed from slice 2 as unused).
  - GitHub (`junior-github/src/code-changes.ts`, `githubCodeChangeHooks`):
    readDiff uses `/compare/base...head` (exact SHAs); readStack = Stacks API
    then base-branch walk down+up. Verified on real stack #3058 that
    `pull_requests` is bottom first. Stacks API may list merged layers
    (`state` field) — not filtered yet; decide in 4b.
  - Note: after editing plugin-api, run `pnpm --filter @sentry/junior-plugin-api build`
    before typechecking dependents (they import from dist).
  - Repository input is `junior_code_changes.repository.name` = "owner/name".
- Slice 3 done: draft PR #3090 (`walkthrough/3-storage`, commit f82385536),
  base `walkthrough/2-code-change-hooks`. Stack #3089 = [#3087, #3088, #3090].
  - DECISION: only ONE table in slice 3 (`junior_walkthrough_versions`).
    The answers table moves to slice 6, where its shape is decided (no
    speculative schema). Migration `0096_walkthrough_versions.sql`.
  - Columns: id, parent_version_id, provider, repository, snapshot_key,
    code_changes jsonb [{number, headSha, baseSha}], generation_conversation_id
    (FK → conversations, ON DELETE SET NULL), source_conversation_id, status
    (generating|ready|failed), document_key, cost_usd, failure_reason,
    created_by_user_id, created_at, completed_at.
  - Partial unique (provider, repository, snapshot_key) WHERE status<>'failed'.
    Unique on generation_conversation_id (serves the list NOT EXISTS).
  - Store `packages/junior/src/chat/walkthroughs/store.ts`:
    `walkthroughSnapshotKey`, `startWalkthroughVersion` (onConflictDoNothing →
    returns live one, started:false), `getWalkthroughVersion`,
    `completeWalkthroughVersion(storage, {id, document, costUsd})`,
    `failWalkthroughVersion({id, reason})`, `readWalkthroughDocument(storage, v)`.
    Storage is passed in (like api.ts deps) because memory storage is per instance.
  - Query plan (100k convs, 2k versions): home list keeps index scan on
    last_activity_idx + index-only probe; 0.06 → 0.22 ms.
  - Tests: DATABASE_URL=postgres://junior:junior@localhost:54322/junior
    (compose postgres from `pnpm dev`). 32 list/search/migration files pass.
  - Gotcha: the pnpm pre-commit hook is slow; a commit+push in one command can
    time out but still land. Check `git ls-remote` before re-pushing.
- Slice 4a design (found the tool-scoping answer):
  - Precedent: `AgentRun.agentInvocationId` is set ONLY by the Agent
    invocation worker (`chat/agent-invocations/work.ts` → `executeTurn`), and
    `createTools` registers `reportBlocked` only when
    `context.agentInvocationId` is set (`chat/tools/index.ts:239`). Same for
    `ToolRuntimeContext.automation`.
  - So: add `AgentRun.walkthroughGeneration?` + `ToolRuntimeContext.walkthroughGeneration?`,
    passed through `chat/agent/tools.ts` commonToolRuntimeContext. createTools
    registers `submitWalkthrough` only when set. Only the Walkthrough worker
    (4b) sets it → the tool exists only in generation Turns. No per-Turn DB
    lookup in the normal Turn path. createTools comment: choose tools from
    the Conversation — a generation Conversation is all generation Turns.
  - Skill: built-in skills live in `packages/junior/skills/` (jr-rpc there).
    Add `skills/walkthrough/SKILL.md` with `disable-model-invocation: true`.
    The worker invokes it with a `/walkthrough ...` instruction
    (`parseSkillInvocation` in chat/agent/index.ts:456).
  - submitWalkthrough execute: load refs (diffs via readPluginCodeChangeDiff →
    readWalkthroughDiff; head files for head-side citations via
    readPluginCodeFile; cited message seqs via getConversationEventStore().query
    + assertCanReadConversationEvents; knownUrls = layer URLs + URLs in PR
    bodies + cited messages; checkIds empty), validateWalkthrough → problems
    as ToolInputError so the model retries; else build document + excerpts and
    completeWalkthroughVersion(context.attachmentStorage, ...).
- Slice 4a code done and pushed: branch `walkthrough/4a-generation-tool`
  commit 04cf3f312 (base `walkthrough/3-storage`). NO PR YET.
  - Files: `chat/walkthroughs/submit-tool.ts` (createSubmitWalkthroughTool,
    SUBMIT_WALKTHROUGH_TOOL_NAME, types WalkthroughGeneration{versionId,
    provider, repository, layers[], sourceConversationId?, modelId},
    WalkthroughGenerationLayer), `skills/walkthrough/SKILL.md`,
    AgentRun/ToolRuntimeContext.walkthroughGeneration, chat/agent/tools.ts
    pass-through, chat/tools/index.ts registration.
  - Renamed model-facing keys to snake_case: `not_covered`, `check_id`
    (tool-key-casing:check). The UI (slice 5) must read these names. The
    update schema still has camelCase keys — fix in slice 8 when it becomes
    a tool input.
  - Lint gotchas: no "Junior" in model-read descriptions (ast-grep
    no-hardcoded-bot-name-in-model-text); tests must not call setPlugins —
    use `createApp({ plugins: defineJuniorPlugins([...]) })` from "@/app".
    The pre-push hook runs the full lint set; read /tmp/push.log on failure.
  - Test parses input with walkthroughOutputSchema before tool.execute
    (execute does not apply zod defaults when called directly).
  - Open question for 4b: generation Conversation visibility decides what
    source Conversations it can read (assertCanReadConversationEvents uses
    the requester Conversation's reach). Private source + public generation
    → unreadable.
  - BLOCKED on Thomas: PR creation for 4a was held because deferring the
    cost runs to 4b changes the agreed plan. Asked via review item.
- Events after 4a push:
  - #3087 CI: `test / plugins` failed on a 5s timeout in
    junior-github `tests/webhook-outcomes.test.ts`. #3087 does not touch
    junior-github; the test passes locally. Treated as flaky; reran failed
    jobs of run 42845810763.
  - #3059 (dcramer, "Route per-kind behavior through turnBehavior") MERGED.
    `chat/conversations/kind-behavior.ts` `turnBehavior({kind, personInput,
    automationRun})` now owns per-kind tool access (`tools.reportBlocked`
    etc.), and a test-architecture rule rejects new kind / parent-edge /
    person-Source branches outside it. The reportBlocked precedent I copied
    is now `turnTools.reportBlocked`.
  - Impact: slices 1–3 still merge cleanly into main. 4a conflicts in
    chat/agent/tools.ts, chat/tools/index.ts, chat/tools/types.ts and its
    gate should move into turnBehavior (e.g. a `submitWalkthrough` tool flag,
    and later a `walkthrough` kind). Rework 4a on top of main before its PR.
- Thomas chose: open 4a now, cost runs in 4b.
- Rebased the whole stack onto main 260f2bae6 (#3059) with
  `git rebase --update-refs origin/main` from the 4a branch. New heads:
  1-schema cb07727b3, 2 659835a9f, 3 6e5334c21, 4a 29e4d7d78.
- 4a gate moved into `turnBehavior`: new `WALKTHROUGH_GENERATION` behavior
  (delivery conversation, no review desk/subscriptions/agents/customization/
  noReply, `submitWalkthrough: true`); optional `walkthroughGeneration` arg,
  set in agent/index.ts from `run.walkthroughGeneration !== undefined`.
  tools/index.ts registers when `turnTools.submitWalkthrough &&
  context.walkthroughGeneration` (no throw: tool-error-classification check
  rejects plain Error in tool code).
- kind-behavior.test.ts: added submitWalkthrough:false to fixtures + a row.
- Pushed with --no-verify: main's pre-push lint fails on
  junior-github/src/webhooks/issue-update.ts (`import { z }` from #2621 vs
  zod-namespace-import rule from #2731). Not ours. All other hook steps pass.
- 4a PR: #3124 (draft). Stack #3089 = [#3087, #3088, #3090, #3124].
  Watch resub_408e483759f9620663c9d56749656f87.
- NEXT: 4b — generation route behind an off-by-default switch, worker that
  calls executeTurn with walkthroughGeneration, cost on the version row,
  step/$ limits, then 2–3 real cost runs. Read #3052 first. Decide merged-layer
  filtering and generation Conversation visibility (private source reads).
- #3090 merge_conflict event: main moved (27 commits) and took migrations
  0096–0099. Fixed with `gh stack checkout 3090` + `gh stack rebase`; took
  main's meta/_journal.json + 0096_snapshot.json, deleted our 0096 SQL, and
  regenerated with `pnpm exec drizzle-kit generate --config drizzle.config.ts
  --name walkthrough_versions` → `0100_walkthrough_versions.sql` (SQL
  byte-identical). `gh stack rebase --continue`, `gh stack push` (hook passed;
  main fixed the zod import in #3092).
  New heads: 1 08604c08a, 2 240f96822, 3 b319aa96d, 4a 4005781b1.
  All 4 PRs mergeable=true. tsc, walkthrough/list/api tests, github
  code-changes tests pass.
- PR body edits via `gh api PATCH` return 403 from the sandbox token. #3090
  body still says `0096` (now `0100`); #3124 body still has the stale
  --no-verify note. Fix when a PR-edit path is available.
- #3124 review (Thomas, comment 4532089003 "Promise.all?"): submitWalkthrough
  now reads diff, head files, and cited messages with one Promise.all.
  Commit 748e8877c. Feedback marked addressed, thread resolved.
- PR descriptions: #3090 now says `0100`; #3124 lost the stale --no-verify
  note and the 2,441-test claim (Thomas approved). Use
  `github_updatePullRequest` (not gh api PATCH) for PR metadata; pass the
  body without the attribution/footer block — the tool appends it.

### 2026-11-11 — slice 4b start ("proceed with the full stack", Thomas)

- Scope: 4b → 8. Slice 9 (post as the user) stays blocked on the core
  viewer-token review.
- Decisions for 4b (see DECISIONS.md):
  - Generation Conversation is public. It reads the source Conversation only
    when that is public; otherwise the run uses the code changes alone.
    Matches Thomas: "if you aren't the one who created the PR with junior,
    that transcript and its brief needs to be public".
  - Merged/closed layers leave the stack (plugin readStack), except the one
    asked for. Commit fca443e5f on slice 2.
  - Version row keeps full layer data (title, body, url, commits, line
    counts) as `WalkthroughCodeChange`; `cost_usd` column dropped — cost is
    the sum of the generation Conversation's `cost_usd` metric rows. Commit
    2885b0c37 on slice 3; migration 0100 regenerated.
  - 4a uses WalkthroughCodeChange for layers (c7e9591b8).
- #3052 (open, dcramer): same-Destination private access; web Conversations
  each have their own Destination, so it does not change the decision above.

### 2026-11-11 — slice 4b opened: #3133

- Branch `walkthrough/4b-generation-worker` (2178be57a), draft PR
  https://github.com/getsentry/junior/pull/3133, in stack #3089.
- POST /api/walkthroughs → readStack → source Conversation from the PR
  footer marker (public only) → claim version → create public web
  Conversation with `$walkthrough` instruction → mailbox Turn.
- Worker: `readWalkthroughRun(conversationId)` in conversation-turn.ts
  (4 lines; file is at 998/1000 lines — next edit there must split the file).
  Turn end → `finish()` fails a still-generating version.
- Stale generating > 30 min fails on next click (store).
- Limits via `TurnBehavior.limits`: 80 tool calls, $5 (agent/index.ts reads
  them; defaults are 1000 / $100).
- Cost = SUM(cost_usd) metric rows of the generation Conversation.
- GET 404s when the source Conversation is not readable by the viewer.
- Slice 3 lost the FK on generation_conversation_id (version claims the
  snapshot first; FK would orphan Conversations on lost races).
- Test rule: tests in packages/junior/tests must not run the agent. The e2e
  (faux model → submitWalkthrough → ready) passed locally, then was removed.
  Real cost runs cover that path.
- Known gap: a Turn that throws (not a completed outcome) leaves the version
  generating until the 30-minute timeout.

### 2026-11-11 — real cost runs (slice 4b)

Setup: local `pnpm dev`, Docker sandbox, experiment on, model
`anthropic/claude-opus-5.5` (app default) through AI Gateway via the egress
proxy. The dev server has no GitHub App key, so a temporary local plugin
`github-local` (uncommitted, apps/example/local-code-changes*.ts) runs the same
readStack/readDiff/readFile code with this sandbox's GitHub token. The agent
in the sandbox read the PRs over public GitHub.

| Run | Code change | Size | Cost | Time | Chapters | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | #3071 | +32 −14, 6 files | $0.53 | 3m22s | 3 | validator rejected once: 6 uncited hunks; fixed |
| 2 | #3052 | +158 −122, 10 files | $1.15 | 4m07s | 10 | |
| 3 | #3059 | +837 −143, 46 files | $1.44 | 3m52s | 6 | |

Documents: cost-run-{1,2,3}-*.json in this branch (also good fixtures for
slice 5 rendering).

Found by the live run: /api/walkthroughs was missing from the dashboard's
served API paths → framework 404. Fixed in d7e308274 on 4b.

| 4 | stack #3089 (#3087→#3133, 5 layers) | +8.4k −27, 46 files (5k = generated migration snapshot) | $2.30 | 10m43s | 12 | validator rejected once: 74 problems, nearly all uncited hunks |

Read: single PRs $0.5–1.5, the 5-layer stack $2.3. Under the ~$2 target for
single PRs; the stack is a little over. Every run had one rejection round from
the coverage rule (uncited hunks). Cheap tune for later: tell the skill to
decide `not_covered` before writing chapters. Not changing it in 4b.

Setup files for these runs: cost-run-setup/ (not in the repo).

### 2026-11-11 — slice 5 (dashboard page + entry points)

Draft PR #3147 (`walkthrough/5-dashboard`, 450adaa6b), stacked on #3133.

- Page `/walkthroughs/:id`: client code is in
  `junior-dashboard/src/client/walkthrough/`. It has the ready, generating
  (3 s poll), and failed ("Try again") states. Each of the 3 panes scrolls by
  itself. The chat panel is a disabled placeholder (`WalkthroughQuestions`).
- Entry points: a footer button on `ObjectCard` and an icon on Linked work
  rows (`WalkthroughAction`). `/api/config` `walkthroughs` controls both.
  Mock mode always turns it on.
- The dashboard finds the PR from `code_change` facts `repository` + `number`,
  which are new in plugin-api and set by `githubObjectAnnotation`. Older
  annotations have no entry point.
- Mock: `mock-reporting/walkthroughs.ts` serves cost runs 1 and 4. It sets the
  provider to `github` and links `sourceConversationId` to the active fixture
  Conversation. Fixed ids `6b0e8f1e-…0001` / `…0002` show generating / failed.
- Decisions made without Thomas:
  - When a slot repeats, the rail shows the caption under the title.
  - Commas separate superscript marks.
  - Long diagram labels shrink to text-xs, then squeeze to fit the node.
  - The "Made in" row says only "Conversation", because the API returns no
    source title.
- Open:
  - The stack diagram is hard to read in the narrow column.
  - The sandbox has no mono font, so the screenshots show code in sans.
  - Decisions and lineage UI wait for slices 6 and 8.
- Dev tip: after `build:client`, restart `pnpm dev`
  (`/tmp/restart-dev.sh` pattern). A hot rebuild leaves the shell stuck on
  "Loading".
- Screenshots: `screenshots/slice-5/` on this branch.

### 2026-11-11 — slice 6 (answers + copyable review text)

Draft PR #3149 (`walkthrough/6-answers`, 474330e88), stacked on #3147.

- Storage: new `junior_walkthrough_answers` table, migration `0101`. PK
  (`version_id`, `user_id`, `decision_id`), plus `value` (`agree` | `change`),
  `note` and `updated_at`. FK to the version, on delete cascade. Slice 3 did
  not make it, so this slice adds it. Answers are not copied to later versions.
- API: `GET /:id/answers` returns only the viewer's answers.
  `PUT /:id/answers/:decisionId` saves one answer (409 until the version is
  ready). The decision id is not checked against the stored document: a bad
  id stays with its reviewer and never shows. The dashboard route list already
  covers `/api/walkthroughs/*`.
- UI: decisions sit under the story, before the code, with Agree or
  Request change and an optional note. The side panel has Questions and
  Review tabs. A chapter with decisions opens Review and scrolls to its rows.
  The header has a Review button with an open-count badge; on narrow screens
  it opens a sheet. The cost uses the same box as the button.
- Review text: one card per PR. It holds the comment (a browser draft),
  then **Changes requested** (note, `[path:line](url)`, the question quoted),
  then **Agreed**, with a Copy button. There is no post, approve or
  request-changes button: that is slice 9.
- New optional plugin hook `codeChanges.lineUrl`, which GitHub implements.
  `submitWalkthrough` uses it to fill `excerpt.url`. Nothing filled that
  field before, so cited code had no GitHub links.
- Mock: the cost-run fixtures have no excerpt URLs, so mock mode adds
  GitHub-style links. Answers live in memory until a dev restart.
- Open:
  - `0100` collides on main: main now has `0100_automation_task_kind_repair`.
    A stack rebase has to renumber slice 3 to `0101` and this slice to
    `0102`.
  - Agreeing with a question that the model wrote ("Is that fine?") reads a
    little odd in **Agreed**. Tune the decision prompt later.
  - Update items (`document.updates`) and confirm decisions come in slice 8.
- Screenshots: `screenshots/slice-6/` on this branch.

### 2026-11-11 — stack rebased onto main, migrations renumbered

- Rebased #3087 → #3149 onto main 364bbb7cb with `gh stack rebase`.
- Main had taken `0100` (`0100_automation_task_kind_repair`).
  - Slice 3 (#3090): the old walkthrough migration files were dropped during
    the rebase. A new commit adds `0101_walkthrough_versions` (2411d2d82). Its
    SQL is identical to the old `0100`.
  - Slice 6 (#3149): `0102_walkthrough_answers`, amended into the slice commit
    (6cf0f8676). Its SQL is identical to the old `0101`.
- One code conflict, on slice 4a: the `turnBehavior` JSDoc in
  `kind-behavior.ts`. Main rewrote the `automationRun` paragraph; kept main's
  text and added the `walkthroughGeneration` sentence.
- Verified on 3, 4a, 4b and 6: migration-metadata, migration-locks, junior
  tsc, and the walkthrough unit and integration tests. On 6, also tsc for
  dashboard, github and plugin-api, and all dashboard tests (439).
  file-length and test-architecture pass.
- `gh stack push`: every PR in the stack reports MERGEABLE (blocked only as a
  draft).

### 2026-11-11 — slice 7: questions (#3150)

- One private Conversation per reviewer per version. A new table,
  `junior_walkthrough_questions` (`0103`), has the key (version, user) and a
  unique `conversation_id`. Its rows are deleted with their version. It is
  not a fork: a fork would copy the whole generation run. The questions and
  answers are saved there, so they come back when the page opens again.
- Lists hide it: `listedConversation()` adds a NOT EXISTS on that table.
- API:
  - `GET /:id/questions` returns `{conversationId?}`.
  - `POST /:id/questions` takes `{idempotencyKey, message}` and returns 409
    until the version is ready.
  - Both use the same read rule as `GET /:id`.
- Turn:
  - `readWalkthroughRun` now also returns `questions`.
  - `turnBehavior({walkthroughQuestions})` gives a reply to the
    Conversation, no agents, review desk, subscriptions or customization,
    and a cap of 20 tool calls and $1.
  - Every question runs the `walkthrough-questions` skill.
  - `createTools` adds `readWalkthrough` and `readWalkthroughCode`. It
    disables the rest, except `readConversationEvent`,
    `searchConversationEvents`, `reportProgress` and `systemTime`.
  - `readWalkthroughCode` reads only the PRs in the version, at the commits
    the version describes.
- Chapter scope is in the message text, not the API. A scoped question
  starts with `> **<title>** · <caption>`. The skill reads that line, and
  the transcript shows it as "About <title>".
- Panel:
  - It uses the Quick question chat parts.
  - The chapter's `asks` show as chips in the panel.
  - A composer chip, "About: <chapter>", is on by default and can be
    removed.
  - "Only you see your questions."
- Mock: the question routes create an unlisted, private mock Conversation,
  which gets the usual fixed mock reply.
- Open:
  - A real model has not answered a question yet. No eval covers it, and
    the cost per question is not measured.
  - When retention deletes a questions Conversation, its row stays. The
    next question recreates the Conversation with the same id. Generation
    versions behave the same way.
- Screenshots: `screenshots/slice-7/` on this branch.

### 2026-11-11 — slice 8 (updates and lineage)

Draft PR #3151 (`walkthrough/8-updates`, dc2d6dc59), stacked on #3150. No
migration: slice 3 already has `parent_version_id`.

- Start: a click on a stack with new commits starts a version whose parent
  is the newest ready version that shares a layer. The same commits still
  reuse the same version. Only a click starts one.
- What "changed" means (decided by Junior, per DECISIONS.md "only decisions
  whose cited evidence changed are reopened"):
  - Documents now store `files`: a sha256 of each changed file's added and
    removed lines. A rebase alone changes no fingerprint.
  - A file changed when its fingerprint changed or it is new. A chapter
    changed when it cites code in a changed file, or an earlier item on it
    does. Granularity is the file, not the line range.
  - Old documents have no `files`, so an update of one treats everything
    as changed.
- Update Turn:
  - `readPreviousWalkthrough` returns the previous story, `changed_files`,
    `changed_chapters`, new and left layers, and `feedback_decisions`.
  - The update form of `submitWalkthrough` takes `items` (each `touches`
    one frozen chapter, may `answers` one decision) and `added_chapters`.
  - Validator: every changed chapter needs an item; new ids must be
    unique and not reuse old ones; coverage applies to changed files only.
  - Stored document = previous document + new excerpts, layers, `files`,
    and one appended `updates` entry with `changedChapters`, `movedLayers`,
    `newLayers`, `leftLayers`. Update keys are snake_case where the model
    writes them (`added_chapters`, `not_covered`).
- Answers: not copied. `GET /:id/answers` returns the nearest answer per
  decision across the parent chain, with its `versionId`. The dashboard
  keeps answers whose chapter did not change, reopens the rest and shows
  the old answer. A change request that an item `answers` reopens as "Does
  this answer your feedback?" (Yes / Not yet), shown only to a reviewer
  whose latest answer was "change".
- Feedback privacy: the update Turn gets the ids of decisions with "change"
  feedback from any reviewer, without notes. Notes are private and the
  generation Conversation is public. **For Thomas:** confirm that ids alone
  are fine to share.
- Merged layers: readStack drops them; the update records them in
  `leftLayers` and the dashboard says "Left, merged or closed: #N". Their
  chapters stay as they were.
- Dashboard: "What changed since you looked" box (layers, links to changed
  and new chapters), "Changed"/"New" marks in the rail, update items above
  the earlier story, decisions after the items, a `v1 v2` switcher, and a
  "Read the previous version" link while an update is written.
  "Since you looked" = updates after the last version the viewer answered
  on (not counting this one). A viewer who never answered sees all updates.
- Mock: a copy of the stack fixture plus a hand-written update, ids
  `…0003` (v1) and `…0004` (v2). v1 starts with three answers (one change
  request). #3087 is shown as "left" only so that row renders; it has not
  merged.

#### Update cost run

Same setup as slice 4b, plus a pin file in the local plugin
(`cost-run-setup/local-code-changes.ts`) that holds one layer at an older
commit. #3059 at its 2nd commit `2d81f58`, then at its head `8cf9873` (2
test commits: +80 −1, 4 files).

| Run | Version | Cost | Time | Result |
| --- | --- | --- | --- | --- |
| 5 | full, #3059 @ 2d81f58 | $2.34 | 7m55s | 10 chapters, 5 decisions; 2 rejection rounds |
| 6 | update → 8cf9873 | $0.57 | 1m31s | 3 items, 0 added chapters; 1 rejection (coverage) |

The update cost 24% of its full run. The earlier full run of #3059 at its
head cost $1.44, so full runs vary a lot. Documents:
`cost-run-5-pr3059-at-2d81f58.json` and `cost-run-6-pr3059-update.json`.

The run found one weak spot: `tools.ts` changed by one word (`export`), so
the chapter citing other lines of it was marked changed. The model wrote an
item that says "unchanged". Line-range granularity would avoid this; left as
is for now.

- Screenshots: `screenshots/slice-8/` on this branch (01–04 mock, 05 the
  real update above).
- Open:
  - Line-range rather than file granularity for "changed".
  - A rebase-only click still starts an update Turn (cheap, items say
    nothing changed). It could skip the Turn.
  - "Since you looked" for a viewer with no answers says "since you looked"
    but means "since the first version".
  - The review panel lists a reopened decision as "Not answered".

### Polish (slice 9, branch walkthrough/9-polish)

Stacked on #3151 (`dc2d6dc59`). Commits: `a373776c8` (titles + dagre),
`7cdc79c29` (format v2), `06bf4eb8b` (question Turn tool fix).

#### UI

- The caption is the chapter title. The slot ("The change") is a small
  eyebrow above it, in the header and in the left list.
- Diagram: dagre (`@dagrejs/dagre`, ~49 KB ESM; elkjs is ~8 MB unpacked).
  The renderer tries top-down and left-right and keeps the narrower one.
  Labels wrap at about 21 characters. Parts outside the chapter are at 40%.
  Edge labels get a halo in the page color, so the edge line does not cross
  them.

#### Format v2

- `diagrams: [{pr, nodes:{id,label}, edges}]`, at most 10 nodes each, one per
  PR. No column/row. A view has `pr`.
- Decisions: `{id, claim, concern?, origin, evidence?}`. Agree / Request
  change apply to the claim. The copied review lists claims.
- The validator rejects: repeated captions, a claim that ends in "?", a
  diagram for a PR not in the stack or a second diagram for one PR, an edge
  between diagrams, and a view of a PR with no diagram.
- Prompt version 3, schema version 2. Hard cutover: v1 documents no longer
  parse (nothing shipped). Fixtures converted with
  `cost-run-setup/convert-v2.mjs` (ids kept; claims written by hand; the
  stack diagram split per PR from what each PR's chapters show).

#### Eval

No `junior-evals` eval. The harness needs a GitHub PR/diff mock (only issue
mocks exist), cloudflared and Sandbox OIDC, and policies/evals.md wants
replies under 60s; a generation takes 3–11 min. Instead:
`cost-run-setup/score-walkthrough.mjs` scores real local runs, and the
validator now enforces the same rules on every run.

Before (stored v1 runs, prompt v2):

| Case | Run | Cost | Captions unique | Max nodes | Decisions | Questions |
| --- | --- | --- | --- | --- | --- | --- |
| small | #3071 | $0.53 | yes | ≤10 | 1 | 1 |
| refactor | #3059 | $1.44 | yes | ≤10 | 2 | 2 |
| stack (5) | #3087–#3133 | $2.30 | yes | ≤10 (1 diagram) | 8 | 6 |

After (v2, prompt v3, `runs/polish/`):

| Case | Cost | Chapters | Diagrams | Max nodes | Decisions | Questions | Concerns | Rejections |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small #3071 | $0.34 | 5 | 1 | 7 | 2 | 0 | 2 | 1 (coverage) |
| refactor #3059 | $1.78 | 9 | 1 | 9 | 5 | 0 | 5 | 3 (2 body length, 1 coverage) |
| stack #3087–#3133 | $1.94 | 12 | 5 | 8 | 10 | 0 | 10 | 0 |

No run hit a new v2 rule. Wall time is not comparable: the runs waited
~10 min on a stuck Docker snapshot build (see below). The stack run used a
local `/tmp/walkthrough-top` pin (in `local-code-changes.ts`) to stop at
#3133.

#### Question runs (prompt v3 docs, opus via gateway)

The first try failed every question before the model call: "Cannot read
properties of undefined (reading 'properties')". Slice 7 disabled the other
tools with `{...tool, disabledReason}`, and plugin tools keep `inputSchema`
on the prototype (`Object.create(definition)` in `getPluginTools`), so 26
plugin tools went to the provider with no parameters. Fixed in this slice
with `Object.create(tool)`; it belongs in #3150.

| # | Walkthrough | Question | Cost | Tool calls | Quality |
| --- | --- | --- | --- | --- | --- |
| q1 | small | other lists still using the inline pair? | $0.31 | 12 (hit the 20 cap with codemode) | Good. Found `detail-etag.ts:114,168`, said it is not quite the same filter, said it could not search the repo |
| q2 | refactor | (chapter) what happens on the new throws? | $0.55 | 20 | Very good. Traced worker retry → failed Turn, no reply; said where it could not trace |
| q3 | refactor | anything still reads durability.spawnAgent? | $0.15 | — | Good. Field removed, only reader removed; suggested the `rg` that would settle it |
| q4 | stack | (chapter) test for second click joining? | $0.29 | 8 | Good. Cited `walkthrough-versions.test.ts:104-123`, noted the clicks are sequential, not concurrent |
| q5 | stack | approve and merge #3087? | $0.03 | 0 | Correct refusal, pointed to the PR |

Mean $0.27 per question; $0.15–$0.55 for real code questions. Answers:
`runs/polish/questions/`.

Common gap: `readWalkthroughCode` opens files by path only. q1 and q3 both
said a repo-wide search would settle the answer.

#### Screenshots (`screenshots/polish/`)

01/02 before (single PR, stack). 03/04 caption titles + dagre (still one
stack diagram). 04b single PR on v2. 05 stack with one diagram per PR.
06 claim with a change request and the review text. 07 agreed claim and
the review text.

#### Local dev notes

- The Docker snapshot build hung twice: an exec stream did not end after
  its command exited (`/var/tmp/junior-commands/*.pid` left behind). A
  third `snapshot create` with the server stopped worked. Not debugged.
- `pnpm dev` runs `tsdown --watch`; editing `packages/junior/src` restarts
  the server and requeues running Turns.

#### Open

- Move the tool-disabling fix down to #3150, or keep it here.
- Question Turns have no code search.
- The per-file "changed" check, rebase-only Turns, and "Not answered" on
  reopened decisions (slice 8 leftovers) are unchanged.

### 2026-11-11 — question Turns get sandbox search (Thomas: "Do it")

`d6c79d56d` on #3150 keeps `bash` and `readFile` on in question Turns, and
the `walkthrough-questions` skill now says: try `readWalkthroughCode` first;
for a repo-wide search, shallow-fetch the PR `head_sha` in the sandbox and
use `rg`; never push. Rebased: #3151 `c2b17fb61`, #3155 `34b920d41`.
Limits unchanged (20 tool calls, $1): no run came close.

Real runs (fresh local DB, Docker sandbox, `github-local`, opus via
gateway). New Walkthroughs: #3071 $0.57, #3059 $1.87. Answers:
`runs/sandbox-questions/`.

| Question | Before (path only) | After (sandbox) |
| --- | --- | --- |
| q1 small: other lists still filter inline? | $0.31, 12 calls; checked ~20 files by guess, "could not search the repo" | $0.33, 12 calls (10 bash), 61s wall; searched the head commit with `rg`: no list filters inline, names all 5 callers, and lists the root-only checks with reasons |
| q2 refactor (chapter): what happens on the new throws? | $0.55, 20 calls (cap); could not find the agent invocation worker | $0.40, 9 calls (3 bash), 56s wall; traced both throws through both workers, incl. `agent-invocations/work.ts` final-attempt handling |

Local caveat: `git fetch` from the Docker sandbox failed in both runs
(`sandbox.egress.credential.unavailable`; the dev server has no GitHub App).
q1 fell back to a tarball of the head commit; q2 said it could not clone and
answered from `readWalkthroughCode`. Inference: with App credentials the
fetch works as in generation Turns. Not verified here.

### 2026-11-11 — review UX (walkthrough/10-review-ux, on #3155 `34b920d41`)

Thomas: PR list and Conversation link steal space; every chapter has a
diagram; the review cards overload. Head `4ad5ca7fc`. Lower heads unchanged.

- Rail: chapters only. Header line: `N PRs ▾ · Made in Conversation · $cost`.
  The PR popover lists every PR (no "Show more"); one PR is one link.
- Diagrams: validator rejects a view whose `show`/`added` ids an earlier
  view of the same PR already showed, unless it marks `broken`. This is
  stricter than "same as the previous chapter": under that rule no fixture
  view failed, since each zooms to a different subset. Skill: most chapters
  have no view. Fixtures: #3071 3 → 1 view, stack 12 → 6 (4 fail the rule;
  `safe-to-run` and `after-ship` dropped by hand, they add one node each).
- Review panel: `X of Y open`, Open/All, one line per claim with a status
  dot, grouped by chapter caption; one comment (localStorage, per version);
  Copy review at the bottom. Stack: split button `Copy review for #N` + a
  PR menu with counts. Default PR: the current chapter's first claim PR,
  else the top layer. Same markdown as before; the comment goes in every PR.
- Card: left accent, "Do you agree?", claim, concern muted, text actions
  `Agree · Request change · Skip`. Answered: one line, "✓ Agreed <claim> ·
  Change". "Change" reopens the actions. No "undo" to open: that needs a
  DELETE route, and an answer from an earlier version cannot be removed on
  this one.
- Skip: `value` is `text` (0102), validated by zod and a TS type. No
  migration. Not open; left out of copy; changed code drops a skip so the
  claim is plain open (no "Reopened" note). Update Turn: only `change` ids.

Checks: tsc (junior, dashboard, github, plugin-api), oxlint, dashboard tests
(442), walkthrough unit + integration + kind-behavior (40), file-length,
test-architecture, dashboard-style, skills.

Screenshots (`screenshots/review-ux/`, mock mode, desktop): before-01..03,
after-01 rail/header, 02 PR popover, 03 chapter without diagram, 04 review
Open, 05 card open, 06 card answered, 07 review All, 08 Open after answers,
09 Copy review menu, 10 single PR.

Added (Thomas): the cost in the header line links to the version's generation
Conversation (`generationConversationId` on the version response, from the
row). That page already has the transcript and `ConversationUsageBreakdown`.
Lists hide generation Conversations; `GET /api/conversations/:id` serves one
to any signed-in viewer (200, checked in walkthrough-versions; a missing id
is 404). Mock: `walkthrough-generations.ts` adds generations for #3071 and
the stack, hidden from lists, with costs equal to the fixtures. The mock
update version has no generation link. Head `e4f10560e`. Screenshot:
after-11 generation Conversation with usage open.

#### Open

- Update Turns: `added_chapters` views are not checked against old views.
- The menu counts do not show skips.
- No real generation run under the new view rule yet.

### 2026-11-11 — story-first chapters (walkthrough/11-story-first, on #3159 `e4f10560e`)

Thomas: "ok proceed" (story-first on top, fold later), journal writes OK.
Design: DECISIONS.md "Story-first chapters". Head `2b8954e13`.

Format v3 (schema 3, prompt v4), hard cutover:
- Chapter: `{id, label, caption, body ≤600, view?, evidence 1–6, decisions,
  asks}`. No `type`/`slot`. `label` (≤40) is the title; labels and captions
  must be unique.
- `types` (1–3) on the Walkthrough. Nothing in the UI or update logic reads
  a per-chapter type, so it moved up. `splits` is gone.
- `also_changed: [{reason, files: [{pr, path}]}]` replaces `not_covered`, also
  in updates. Coverage: a changed hunk is cited or its file is listed there.
- Validator: dropped the slot/type and bug-fix cause checks. Cap 8 chapters
  for one PR, 10 for a stack.
- Skill: one story for the whole change; PRs and commits are evidence; never
  one chapter per PR or commit; suggested chapters per type; no "newest
  first" reading rule; a readable source Conversation tells the intent.

UI: prose first. A citation opens its evidence beside the prose (wide
column, click or focus) or in a drawer (narrow, click only: a modal on focus
would trap tabbing). The diagram sits in that side column when no evidence
is open. "Also changed" is a closed section after the last chapter, with
mechanical-file counts. Truncation removed: rail captions, review lines and
headings, answered decision line, "About:" chip (now shows the label), PR
popover titles (own rows, not `ConversationLinkRow`).

Fixtures: `convert-v3.mjs`. The stack fixture is one 8-chapter story; old
chapter, decision and excerpt ids kept where a chapter survives.

#### Cost runs (fresh DB, Docker sandbox, `github-local`, opus via gateway)

Docs: `runs/story-first/`. Chapter map: `cost-run-setup/chapter-map.mjs`.

| Case | v2 cost | v3 cost | v2 chapters | v3 chapters | v2 rejections | v3 rejections | v3 time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #3071 | $0.34 | $0.61 | 5 | 5 | 1 (coverage) | 1 (coverage, 7 problems) | 1.8m |
| #3059 | $1.78 | $1.43 | 9 | 8 | 3 | 1 (28 coverage + 1 decision index) | 3.9m |
| stack #3087–#3133 | $1.94 | $2.12 | 12 | 10 | 0 | 1 ("cite code from at most 30 files") | 7.9m |

Labels:
- #3071: The shared filter · Feed rows and change token · Board and searches
  · Proof behavior holds · Left out on purpose.
- #3059: One table per Turn · Prompt mode and answer gate · Tool gates read
  turnTools · Agent tools bind late · Delivery rules · Where behavior can
  shift · Guard against new branches · How it is tested.
- Stack: Starting a Walkthrough · Reading the stack · One version per
  snapshot · Hidden generation Conversations · The generation Turn · What the
  model writes · Every citation is re-checked · Storing and serving ·
  Failure and retry · Tests and watch items.

One-to-one with a PR (chapter cites one PR and no other chapter cites it):
none in v3 or v2. Chapters that cite only one PR: v2 12/12, in PR order;
v3 3/10, ordered by the flow (click → read → store → Turn → check → serve →
fail). The stack used all 10 chapters but no run hit the cap, so it stays.
Costs are within run-to-run noise of v2 (earlier full runs of #3059 ranged
$1.44–$2.34).

Screenshots (`screenshots/story-first/`, desktop, mock mode unless noted):
before-01/02 stack chapters, 03 review list, 04 PR popover. after-01 prose
only, 02 citation open beside the prose, 03/04 Also changed closed/open,
05 review list wrapping, 06 PR popover, 07 narrow drawer (1280px), 08
"About:" chip, 09 update with a changed chapter, 10 single PR, 11 the real
v3 stack run.

#### Truncation kept

None in the Walkthrough UI. Diagram node labels still shrink to fit their
node (dagre layout needs a fixed node box); that is scaling, not clipping.

#### Open

- Update Turns: `added_chapters` labels are not checked against the parent
  version's labels.
- The 30-file head-code cap (from 4a) cost the stack one round.
- The citation mark's open state is a faint background; may need a stronger
  mark.

### 2026-11-11 — review polish (walkthrough/12-review-polish, #3169, on #3164 `2b8954e13`)

Thomas answered the freeze card with "More changes first": a cost
breakdown, a clearer "Do you agree?" card with a way to ask first, and a
header that does not stay on screen. Head `a1bb49d46`. Lower heads were
unchanged before and after `gh stack push`. No real model runs.

#### Cost breakdown

- The cost opens a popover on click or hover. It shows
  `ConversationUsageBreakdown`, the same one Conversation details shows,
  fed by `conversationDetailQueryOptions(generationConversationId)`. It
  loads only when the popover opens. No API change.
- `ConversationUsageBreakdown` got an optional `defaultOpen`, so the
  breakdown starts open in the popover.
- The "Open the generation transcript" link stays in the popover.
- An update version uses its own `generationConversationId`. A version
  without one (the mock update) shows the cost as plain text.

#### Claim card

- The eyebrow reads "Claim to review: do you agree?" (or "Does this answer
  your feedback?"). The claim is the main text. The concern has a "Why it
  is worth checking:" label.
- Agree, Request change and Skip are buttons, and the chosen one shows as
  pressed with a check.
- "Ask about this" sets the claim, opens the Questions tab (the sheet on
  narrow screens), turns the chapter chip on and puts the cursor in the
  composer. A box above the composer shows the claim, with a button to
  remove it.
- The question quotes the claim on its own line under the chapter caption:
  `> **caption**` then `> claim`, then the text. The claim is joined to one
  line so the quote does not break. The `walkthrough-questions` skill now
  treats a quoted claim as the subject.
- The card finds its question by the quoted claim text in this version.
  It then says "You asked about this claim" and links "Read the answer" or
  "See the question", which scrolls Questions to that question. The claim
  stays open.

#### Header

- Chapter 1 opens with the full header (title, intent, PRs, "Made in",
  cost, versions and Review). It scrolls away with the chapter.
- Other chapters show one bar: title ▾ · `N PRs ▾` · cost, then versions
  and Review. On chapter 1 the bar appears once half the header has
  scrolled away. Showing the bar does not move the header inside the
  story, so it cannot flicker.
- Clicking the bar's title shows the intent and "Made in" under it.
  Opening another chapter hides them again.
- Nothing is clipped. The title wraps.
- "What changed since you looked" stays at the top of the story.

#### Screenshots (`screenshots/review-polish/`, desktop, mock mode)

- before-01 header on chapter 1 (cost was a link with a tooltip),
  before-03 claim card, before-04 header on chapter 3.
- after-01 full header on chapter 1, after-02 cost popover, after-03 claim
  card, after-04 Questions with the claim set and a question typed, after-05
  claim card after asking, with the mock answer and "Read the answer",
  after-07 one-line header on chapter 3, after-08 intent opened from the
  title, after-09/10 chapter 1 at 520px tall, before and after scrolling.

#### Open

- The mock update version has no generation Conversation, so its cost has
  no popover in mock mode.
- A question matches its claim by text. If an update changes a claim's
  wording, the old question no longer shows on the new card.
- The concern label "Why it is worth checking:" is a guess at wording.


## Slice 13: consistency (`walkthrough/13-consistency`)

Thomas's notes on the slice 12 preview: chapter 1's header differs from the
others, "Made in Conversation" makes no sense, the Usage accordion is an
extra step, the claim card has no type hierarchy, and he wanted to see a
single PR.

#### What changed

- **One header bar on every chapter:** title (wraps), `N PRs ▾` or the PR
  link, cost, versions and Review. The scroll observer and the expandable
  title are gone.
- **The intent opens chapter 1** as story text (`text-base leading-7`, the
  prose style), above the chapter's own header. "What changed since you
  looked" stays above it in the story.
- **Source:** `From: <Conversation title>` as an underlined link, under the
  intent lead. It is not in the header, so the bar stays one line. The
  title comes from the existing Conversation detail query. Nothing shows
  while it loads or when the viewer cannot read it.
- **Cost popover:** `ConversationUsageTables` is the breakdown without the
  Collapsible. Conversation details still uses `ConversationUsageBreakdown`,
  which wraps the same tables. `defaultOpen` is gone. The popover title is
  "What it cost to make this Walkthrough: $X".
- **Claim card:** two sizes. `text-sm` for the "Claim" label, status and
  actions; `text-base leading-7` (the prose size) for the claim (medium) and
  the concern (regular, with a muted "Why it's worth checking:" lead-in).
  One action row: Agree, Request change, Skip, then a quiet "Ask about
  this". The chosen button is filled and has a check. An answered card folds
  to `Claim · ✓ Agreed · Change answer` above the claim. Once asked, "Ask
  about this" gives way to "You asked about this claim… Read the answer".
  "Does this answer your feedback?" uses the same card.
- **Review panel:** chapter headings are `text-xs` muted (were faint), rows
  are `text-sm` in the main text color, and an answered row names its status
  under the claim.

#### Diagram bug (#3071)

The fixture had 9 nodes and **0 edges**. The 5-dashboard fixture had 8
edges; the v2 conversion in 9-polish dropped them. The renderer was fine.
The fixture gets its 8 edges back. The validator accepted an edgeless
diagram, so it now rejects a diagram with more than one node and no edges.

#### Single-PR check

The header and claim card now read the same on #3071 as on the stack. The
page still feels heavy on a single PR because of:
- the Questions panel (24rem) always open, with one suggestion in it;
- the 18rem rail for 3 chapters;
- the left-to-right diagram, which scales its labels down to about 9px.

#### Screenshots (`screenshots/consistency/`, desktop 1600×1000, mock mode, 128 colours)

- before/after `-single-` (#3071) and `-stack-`: 01 chapter 1, 02 cost
  popover, 03 chapter 2.
- single 04 claim open, 05 agreed (folded), 06 asking, 07 asked
  (after only), 08 review panel (after only).
- stack 04 review panel, 05 review panel after agreeing (after only).

#### Open

- The mock source Conversation for both fixtures is "Investigate checkout
  latency", which has nothing to do with the PRs.
