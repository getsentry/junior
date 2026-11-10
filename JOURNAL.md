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
