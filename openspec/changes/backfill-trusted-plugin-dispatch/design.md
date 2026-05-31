# Design: `trusted-plugin-dispatch` Baseline Backfill

## Sources Reviewed

- `specs/trusted-plugin-dispatch.md`
- `specs/trusted-plugin-heartbeat.md`
- `specs/scheduler.md`
- `packages/junior-plugin-api/src/index.ts`
- `packages/junior/src/chat/agent-dispatch/types.ts`
- `packages/junior/src/chat/agent-dispatch/validation.ts`
- `packages/junior/src/chat/agent-dispatch/store.ts`
- `packages/junior/src/chat/agent-dispatch/context.ts`
- `packages/junior/src/chat/agent-dispatch/signing.ts`
- `packages/junior/src/chat/agent-dispatch/heartbeat.ts`
- `packages/junior/src/chat/agent-dispatch/runner.ts`
- `packages/junior/src/handlers/agent-dispatch.ts`
- `packages/junior/tests/unit/runtime/agent-dispatch-validation.test.ts`
- `packages/junior/tests/unit/runtime/agent-dispatch-signing.test.ts`
- `packages/junior/tests/integration/agent-dispatch-runner.test.ts`
- `packages/junior/tests/integration/heartbeat.test.ts`
- Vercel Queues docs: https://vercel.com/docs/queues
- Slack `chat.postMessage` docs: https://docs.slack.dev/reference/methods/chat.postMessage

## Prior-Art Interpretation

- Queue systems commonly provide at-least-once delivery and rely on idempotency keys plus durable state to avoid duplicate externally visible effects. Junior follows that model with deterministic dispatch ids, versioned callbacks, and persisted assistant message ids.
- Signed internal callbacks should authenticate the callback body with a shared secret, timestamp, versioned signature, and timing-safe comparison. Junior uses HMAC-SHA256 over a contextualized body and rejects missing, stale, malformed, or mismatched callbacks.
- Slack `chat.postMessage` is channel-id based and can post to public channels, private channels, or IM channels where the bot has permission. Dispatch validation should accept Slack conversation ids, not user ids or thread timestamps.
- Background/system work needs a distinct actor model. Junior dispatches use a system actor owned by the trusted plugin, with interactive auth disabled unless a constrained delegated credential subject is explicitly allowed.

## Design Decisions

### Dispatch Is Core-Owned After Creation

Trusted plugins can create or look up dispatches they own. They do not choose callback URLs, own runner dependencies, receive raw requests, or mutate stored dispatch records directly.

### Idempotency Is Plugin-Scoped

Dispatch ids are deterministic from plugin name and idempotency key. The same plugin/key pair returns the existing record; different plugins may use the same idempotency key without collision.

### Projection Hides Runtime State

`ctx.agent.get(id)` returns only id, status, result timestamp, and error message for records owned by the calling plugin. Prompt text, destination, metadata, actor, conversation, tool calls, logs, credentials, and raw record fields remain hidden.

### System Actor By Default

Dispatch runner calls the agent as `system:<plugin>`, not as a Slack requester. Authorization flow mode is disabled, and auth-required outcomes are persisted as blocked. Delegated user credentials are only allowed for private direct Slack destinations through an explicit `credentialSubject`.

### Callback Loop Uses Versioned Claims

Callback payloads carry dispatch id and expected version. The runner claims records under dispatch lock, rejects terminal/stale/version-mismatched callbacks, then acquires the destination conversation lock. This prevents concurrent execution of the same record and keeps retries bounded.

## Risks

- Delivery is best-effort exactly once, not truly atomic: Slack post success and state persistence can still split.
- Dispatch validation accepts Slack conversation-id shape but does not prove the bot can post before scheduling.
- The current implementation supports delegated credential subjects, which expands the original "system dispatches have no requester OAuth" model. The spec should make this constrained exception explicit.
- Some validation constants and recovery bounds are hard-coded; this baseline should require limits without freezing every number.
- Direct tests for callback handler `waitUntil` behavior and some auth-blocking branches are limited.

## Verification Approach

- Unit tests own validation, signing/parsing, id generation, projection helpers, stale/terminal predicates, and lock/state helper behavior.
- Integration tests own heartbeat dispatch creation, plugin-scoped lookup, recovery, scheduler reconciliation, runner execution, Slack delivery, continuation, and delegated credential subject behavior.
- Evals are only needed for user-visible scheduled/dispatch workflows, not callback mechanics.
