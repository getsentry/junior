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

- Review item 4338131e (dedupe `walkthrough:slice-4a:cost-run`): how to run
  the 4a cost check; sandbox has no AI Gateway key.

## Log

### 2026-11-10

- Thomas approved proceeding with the plan, stacked, with this journal.
- Created this journal branch.
