# Design: `trusted-plugin-heartbeat` Baseline Backfill

## Sources Reviewed

- `specs/trusted-plugin-heartbeat.md`
- `specs/trusted-plugin-dispatch.md`
- `specs/scheduler.md`
- `packages/junior-plugin-api/src/index.ts`
- `packages/junior/src/handlers/heartbeat.ts`
- `packages/junior/src/chat/agent-dispatch/heartbeat.ts`
- `packages/junior/src/chat/agent-dispatch/context.ts`
- `packages/junior/src/chat/plugins/agent-hooks.ts`
- `packages/junior/src/chat/plugins/state.ts`
- `packages/junior/src/chat/plugins/logging.ts`
- `packages/junior/tests/integration/heartbeat.test.ts`
- `packages/junior/tests/unit/app-config.test.ts`
- Vercel Cron docs: https://vercel.com/docs/cron-jobs
- Vercel Queues docs: https://vercel.com/docs/queues

## Prior-Art Interpretation

- Cron/heartbeat triggers are best-effort pulses. They may run late, be skipped, or overlap; durable state and idempotent claiming are the reliability boundary.
- Queue-style recovery should happen before new producer work so stale/incomplete core work can make progress even if plugin heartbeat handlers fail.
- Trusted plugin contexts should expose narrow capabilities, not raw runtime clients or deployment adapter internals.

## Design Decisions

### Heartbeat Is A Pulse, Not A Job Runner

The endpoint authenticates the pulse and schedules bounded background work with `waitUntil`. Plugins must use durable state and idempotent claims instead of assuming exact timing or singleton execution.

### Core Recovery Runs First

Heartbeat first re-drives stale core dispatches, then invokes plugin heartbeat handlers. This keeps core-owned dispatch recovery independent from plugin domain logic and avoids starving recovery when plugins are idle.

### Context Is Narrow And Plugin-Scoped

Heartbeat contexts include `nowMs`, plugin metadata, a plugin-scoped state facade, a safe plugin logger, and `agent.dispatch/get`. They do not expose raw `Request`, `waitUntil`, Slack clients, Redis/state adapters, route registration, or unrestricted agent runtime functions.

### Failures Are Isolated

One plugin heartbeat failure must be logged and isolated from other trusted plugins and core recovery.

## Risks

- Endpoint authentication currently uses a bearer secret from `JUNIOR_SCHEDULER_SECRET` or `CRON_SECRET`; naming may be scheduler-specific even though heartbeat is generic.
- Plugin logger passes arbitrary metadata through to logging helpers; redaction expectations are policy-level, not strongly typed.
- Heartbeat timeout and plugin limit are implementation constants; the spec should require bounds without freezing exact numbers.
- Tool registration is documented here but implemented in plugin runtime hooks; consolidation should avoid duplicate ownership.

## Verification Approach

- Integration tests own endpoint auth, waitUntil scheduling, trusted plugin invocation, plugin state namespace behavior, dispatch fanout limits, scheduler heartbeat behavior, and failure isolation.
- Unit tests own trusted plugin registration validation and plugin state key validation where practical.
- Dispatch retry/recovery details are verified by trusted dispatch tests and referenced here only for ordering.
