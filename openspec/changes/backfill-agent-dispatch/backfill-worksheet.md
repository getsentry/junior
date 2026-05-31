# Agent Dispatch Backfill Worksheet

## Canonical Spec

- New spec: `agent-dispatch`
- Related canonical behavior spec: `trusted-plugin-dispatch`

## Local Artifacts Reviewed

- `specs/trusted-plugin-dispatch.md`
- `openspec/changes/backfill-trusted-plugin-dispatch/specs/trusted-plugin-dispatch/spec.md`
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

## External Sources

- Vercel Queues docs: https://vercel.com/docs/queues
- Slack `chat.postMessage` docs: https://docs.slack.dev/reference/methods/chat.postMessage
- Cloudflare Workers context docs: https://developers.cloudflare.com/workers/runtime-apis/context/

## Decision

The full behavior belongs to `trusted-plugin-dispatch`. This `agent-dispatch` spec is intentionally narrow. It prevents a second behavior spec from diverging and records the internal boundaries that implementation refactors must preserve.

## Undefined Behavior

| Question                                                                             | Current Evidence                                                          | Candidate Decision                                                                       | Status |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| Should `agent-dispatch` be renamed to reduce overlap with `trusted-plugin-dispatch`? | Module and callback route use `agent-dispatch`; spec clarifies ownership. | Rename only if code clarity work is already touching dispatch paths.                     | open   |
| Should handler `waitUntil` behavior have direct integration coverage?                | Signing and runner tests cover most behavior; handler itself is thin.     | Add direct handler coverage if callback routing changes.                                 | open   |
| Should future queue-backed dispatch replace signed callbacks?                        | Current code uses HMAC signed callback fetches.                           | Keep state machine under `trusted-plugin-dispatch`; implementation mechanism can change. | open   |

## Validation

- `openspec validate backfill-agent-dispatch --strict` passed.
