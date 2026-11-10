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
  must exist only in generation Turns (mechanism TBD, first task of 4a).
- Slice 4b: on/off switch, off by default, blocks routes (404); step and
  dollar limits. Slice 5 entry points use the same switch.

## Open questions

- None.

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
