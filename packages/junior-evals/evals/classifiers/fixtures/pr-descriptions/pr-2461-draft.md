**This PR is stacked on #2458** (`fix/bound-thread-reply-state`). That PR is still open. Merge #2458 first, then retarget this PR to `main`.

## Problem

Several Turn-visible Slack posts chose their own channel and thread, and some skipped the Conversation footer. Some paths parsed the Conversation id to find the Slack thread. That gives the wrong answer for Automation and Watch Conversations: they can own a Slack thread, but their ids (for example `agent-dispatch:watch-1`) are not Slack thread ids. The stranded-turn failure in `paused-turn.ts` also posted with raw `postSlackMessage`, so it had no footer.

## Change

**One resolver.** `resolveSlackReplyTarget` in `packages/junior/src/chat/slack/reply.ts`:

- The channel always comes from the Destination.
- The thread comes from the Turn Source, then the Conversation Location, then the Destination. Each one counts only when it names the same channel.
- It never reads the Conversation id.

It replaces `getTurnThreadTs` in `paused-turn.ts` and the Location fallback in `automated-turn-limit-notice.ts`.

**Delivery paths changed.** These now use `sendSlackReply` with the resolved target, so each post has the footer:

- `task-execution/paused-turn.ts`: the stranded-turn failure (`failStrandedTurnWithFallback`). It was raw `postSlackMessage` with no footer and parsed the Conversation id. It now also keeps dispatch reply attribution. The paused resume target also uses the resolver, with no `parseSlackThreadId`.
- `providers/slack/runtime.ts`: the ingress error fallback. It was `thread.post`. Here the Thread is the inbound Slack thread, so the channel and thread come from its Slack thread id.
- `providers/slack/turn.ts`: the auth-pause notice and the provider-config reply. The config reply was `thread.post`, and the auth-pause notice fell back to `thread.post` when it had no thread. The main reply now uses the same resolved target. For dispatch Turns with no outcomes, the reply now uses `destination.threadTs`. Before, it took the thread from the Conversation id, which never contains a thread for `agent-dispatch:*` ids.
- `providers/slack/resume.ts`: the resume notices (`initialText`, auth pause) and the resume failure reply. Before, these used raw `postSlackMessage` when no Conversation id was passed.
- `slack/automated-turn-limit-notice.ts`: now takes the Turn `source` instead of a `threadTs`, and resolves the target from the Location. `conversation-turn.ts` no longer passes the Location thread by hand.
- `providers/slack/system-turn.ts`: uses the resolver for its Location target. Behavior does not change.
- Removed the unused `buildSlackOutputMessage` and its unit tests.

**Left as they are, on purpose** (allow-listed in the guard):

- `ingress/slack-webhook.ts` and `providers/slack/runtime.ts`: `THREAD_OPTOUT_ACK` and `SLACK_SESSION_STOP_ACK` replies to "stop". These are control acks that answer a user command, not Turn output.
- `chat/oauth-flow.ts`: OAuth authorization links. These are private delivery (ephemeral or DM) and must not go to the thread.
- `handlers/oauth-callback.ts`: the "account connected" notice when no Turn resumes. It is a standalone notice, not Turn output.
- `chat/automations/blocked-notice.ts`: a DM to the Automation creator, not Turn output.

## Guard

There are two new ast-grep rules, with tests in `ast-grep/tests/`. They run in `pnpm ast-grep:lint`:

- `no-raw-slack-turn-post`: forbids `postSlackMessage(...)` (calls and imports), `*.chat.postMessage(...)`, and `thread.post(...)` outside `slack/outbound.ts`, `slack/reply.ts`, and the exceptions above. `thread.post` of the two control-ack constants is allowed.
- `no-slack-thread-from-conversation-id`: forbids `parseSlackThreadId(...)` except in an explicit allow list. The allow list has the format owner (`slack/context.ts`), modules that read the Slack thread id of an inbound message (`runtime/thread-context.ts`, `ingress/slack-webhook.ts`, `slack/conversation-context.ts`, `task-execution/slack-work.ts`), and read-only labels and search tools (`api/conversations/projection.ts`, `slack/tools/*`).

`packages/junior/src/chat/slack/README.md` documents the rule.

## Coverage

This PR extends the existing channel-level Watch scenario in `tests/integration/durable-queue.test.ts` (`agent-dispatch:watch-1`). A later human reply in the Watch thread yields. Its resumed worker then dies before it saves. The test asserts that the stranded-turn failure goes to the Watch channel with `thread_ts` set to the Watch thread, and that the Conversation footer is present. The test adds no new `createModelStream` call: it only adds entries to the existing stream.

I also updated two existing assertions. The ingress error fallback now goes through the Slack API, not `thread.post`, so the harness records it as `{ markdown }` and not as a bare string. The two assertions are in `tests/unit/slack/slack-runtime.test.ts` and `tests/integration/slack/bot-handlers.test.ts`.

## Checks

- `pnpm --filter @sentry/junior typecheck`, oxlint on the changed files, and Prettier: pass.
- `pnpm ast-grep:lint`, `pnpm test-architecture:check`, `pnpm file-length:check`: pass.
- Unit and component tests: 2350 pass. The two `slack-runtime` assertions failed at first and pass after the fix above.
- Integration tests that this PR touches, run one file at a time: `durable-queue` (the extended Watch test passes), `bot-handlers`, `agent-continue-slack`, `agent-invocation-concurrency`, `events` (component), and `resume` (component) pass.
- The full local integration run has some failures: `attachment-s3-storage`, `annotation-cards`, `event-automations` (card title), `event-wake-delay`, `bot-image-hydration`, and the `durable-queue` tests "re-parks…" and "completes once when the host deadline hits…". The same tests fail on the base branch without this change, in the same local environment. They are timeouts and environment failures, not regressions.
