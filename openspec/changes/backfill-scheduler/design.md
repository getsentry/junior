# Design: `scheduler` Baseline Backfill

## Sources Reviewed

- `specs/scheduler.md`
- `packages/junior-scheduler/src/types.ts`
- `packages/junior-scheduler/src/cadence.ts`
- `packages/junior-scheduler/src/store.ts`
- `packages/junior-scheduler/src/schedule-tools.ts`
- `packages/junior-scheduler/src/plugin.ts`
- `packages/junior-scheduler/src/prompt.ts`
- `packages/junior-scheduler/plugin.yaml`
- `packages/junior/tests/integration/slack-schedule-tools.test.ts`
- `packages/junior/tests/integration/heartbeat.test.ts`
- `packages/junior/tests/unit/slack/tool-registration.test.ts`
- `packages/junior-evals/evals/core/scheduler.eval.ts`
- RFC 5545 iCalendar: https://www.rfc-editor.org/rfc/rfc5545
- Slack scheduled messages API: https://api.slack.com/methods/chat.scheduleMessage
- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs/

## Prior-Art Interpretation

- Cron systems are trigger pulses, not durable task state. Junior follows that model by using heartbeat to claim due work from durable plugin state and dispatch core-owned agent runs.
- Slack `chat.scheduleMessage` can schedule a fixed message in a Slack conversation, but Junior tasks are agent work contracts that may require tools, credentials, files, and prompt framing at run time. Junior should not model scheduled tasks as pre-scheduled Slack messages.
- RFC 5545 is the broad calendar recurrence prior art. Junior intentionally implements a smaller calendar recurrence model: daily, weekly, monthly, and yearly rules anchored to local time and timezone, with unsupported calendar dates skipped.

## Design Decisions

### Task Contract, Not Stored User Utterance

The stored task text, schedule, destination, actor, and optional credential subject form the execution contract. Original user text is audit context only.

### Active Slack Destination Owns Management

Scheduler tools always derive destination from the active Slack context. Any requester in that same destination may list/manage/run-now tasks for that destination. Creator metadata is audit context, not an ownership gate.

### Calendar Recurrence Is Small And Local-Time Based

Recurring tasks are anchored to an exact first run timestamp and timezone. Recurrence advances calendar dates in local time, not fixed milliseconds, so DST behavior stays aligned with the requested local time.

### Heartbeat Dispatches, It Does Not Execute

The scheduler plugin heartbeat reconciles prior dispatches, claims due runs, builds scheduled-run prompts, and calls `ctx.agent.dispatch`. It never runs the agent inline.

### User Credentials Are A Narrow DM Exception

Scheduled runs are system actor runs. The only user credential exception is an explicit credential subject stored for private direct conversations. Private groups, private channels, public channels, and unknown visibility do not inherit creator credentials.

## Risks

- There are no direct unit tests for `cadence.ts` recurrence edge cases such as DST and invalid monthly/yearly dates, although behavior is implemented.
- Conversation access is inferred from Slack channel id prefix, not Slack conversation metadata. Public/private channel visibility can remain unknown.
- Management authorization is intentionally broad: anyone who can act in the destination can manage that destination's tasks.
- Natural-language schedule extraction depends on model behavior and evals; deterministic tools require exact ISO timestamps.
- Missed-run stale cutoff and scheduler limits are implementation constants; spec should require bounded behavior without freezing every number.

## Verification Approach

- Unit tests should own pure calendar and prompt helpers when edge cases expand.
- Integration tests own Slack schedule tools, store/claim behavior, heartbeat dispatch/reconcile, missed-run handling, and destination/credential constraints.
- Evals own model-dependent schedule extraction, confirmation decisions, and "scheduled execution versus schedule creation" prompt behavior.
