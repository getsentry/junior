# Design: Agent Dispatch Ownership Baseline

## Sources Reviewed

- `specs/trusted-plugin-dispatch.md`
- `openspec/changes/backfill-trusted-plugin-dispatch/specs/trusted-plugin-dispatch/spec.md`
- `openspec/changes/backfill-trusted-plugin-dispatch/design.md`
- `packages/junior/src/chat/agent-dispatch/types.ts`
- `packages/junior/src/chat/agent-dispatch/validation.ts`
- `packages/junior/src/chat/agent-dispatch/context.ts`
- `packages/junior/src/chat/agent-dispatch/store.ts`
- `packages/junior/src/chat/agent-dispatch/signing.ts`
- `packages/junior/src/chat/agent-dispatch/heartbeat.ts`
- `packages/junior/src/chat/agent-dispatch/runner.ts`
- `packages/junior/src/handlers/agent-dispatch.ts`
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`
- `packages/junior/tests/unit/runtime/agent-dispatch-validation.test.ts`
- `packages/junior/tests/unit/runtime/agent-dispatch-signing.test.ts`
- `packages/junior/tests/unit/queue/thread-message-dispatcher.test.ts`
- `packages/junior/tests/integration/agent-dispatch-runner.test.ts`
- `packages/junior/tests/integration/heartbeat.test.ts`

External prior art reviewed:

- Vercel Queues docs: at-least-once delivery and idempotency-key deduplication are the right mental model for dispatch retries.
- Slack `chat.postMessage` docs: dispatch destinations must be Slack conversation/channel ids, not arbitrary user ids or thread timestamps.
- Cloudflare Workers `ctx.waitUntil` docs: authenticated handlers can acknowledge quickly while continuing bounded background work.
- Webhook signing guidance: HMAC signatures, timestamp windows, and constant-time comparison are standard controls for internal callback authentication.

## Ownership Decision

Do not create a broad second OpenSpec capability for dispatch behavior. `trusted-plugin-dispatch` is the canonical behavior spec because it is the user/plugin-facing contract and already covers the durable runner. `agent-dispatch` should only specify:

- the internal implementation boundary;
- invariants needed to prevent accidental coupling to Slack interactive turn handling;
- non-overlap with queued inbound Slack message dispatch;
- verification ownership for internal refactors.

## Boundaries

### Internal Agent Dispatch

`chat/agent-dispatch/*` owns the core implementation used after a trusted plugin requests background work:

- create plugin-scoped heartbeat context;
- validate dispatch options;
- create idempotent durable records;
- sign and verify internal callbacks;
- recover stale incomplete dispatch records during heartbeat;
- run one bounded agent slice;
- persist conversation/artifact/sandbox/dispatch state;
- deliver Slack output best-effort exactly once.

### Trusted Plugin Dispatch

`trusted-plugin-dispatch` owns the behavior contract:

- plugin-facing `ctx.agent.dispatch`;
- `ctx.agent.get` projection;
- durable state machine;
- locking, retries, recovery, continuation, blocking, limits, and delivery semantics.

### Slack Thread Message Dispatch

`chat/queue/thread-message-dispatcher.ts` is not agent dispatch. It rehydrates queued inbound Slack messages and routes them through the interactive Slack runtime. It must stay separate because it handles user-authored Slack events, not trusted-plugin-created synthetic system turns.

## Undefined Behavior

- The current handler uses `waitUntil` but direct handler coverage is limited; most verification is through signing and runner tests.
- The `agent-dispatch` module name can look like a product capability even though `trusted-plugin-dispatch` owns the behavior. The spec should make this explicit.
- Dispatch and queued Slack thread messages both use "dispatch" terminology. Renaming may be useful later, but not as part of this baseline.
- Existing recovery is heartbeat-driven. If a real queue backend replaces signed callbacks later, ownership should stay with `trusted-plugin-dispatch`, not a new capability.

## Verification Strategy

- Unit tests cover validation and signing because these are deterministic internal boundaries.
- Integration tests cover runner behavior because it crosses state, conversation memory, Slack delivery, resumability, auth blocking, and plugin heartbeat.
- Queue thread message dispatcher tests remain under Slack/queue behavior, not agent dispatch.
- No evals are required for internal agent-dispatch mechanics. Evals belong to scheduler or provider workflows that create visible dispatched work.
