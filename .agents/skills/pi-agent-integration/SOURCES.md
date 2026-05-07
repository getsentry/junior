# Sources

Retrieved: 2026-03-05
Skill class: `integration-documentation`
Selected profile: `references/examples/documentation-skill.md`

## Source inventory

| Source | Trust tier | Confidence | Contribution | Usage constraints |
| --- | --- | --- | --- | --- |
| `AGENTS.md` (junior) | canonical | high | Repository conventions and Pi streaming standard (`message_update`/`text_delta` -> `AsyncIterable`) | Repo-local guidance |
| `.agents/skills/skill-writer/SKILL.md` | canonical | high | Required workflow for synthesis/authoring/validation outputs | Skill-authoring process source |
| `.agents/skills/skill-writer/references/mode-selection.md` | canonical | high | Class selection and required outputs | Process guidance |
| `.agents/skills/skill-writer/references/synthesis-path.md` | canonical | high | Provenance, coverage matrix, depth gates | Process guidance |
| `.agents/skills/skill-writer/references/authoring-path.md` | canonical | high | Required artifact set for integration-documentation skills | Process guidance |
| `.agents/skills/skill-writer/references/description-optimization.md` | canonical | high | Trigger quality constraints | Process guidance |
| `.agents/skills/skill-writer/references/evaluation-path.md` | canonical | high | Lightweight evaluation rubric | Process guidance |
| `<pi-mono>/packages/agent/README.md` | canonical | high | Public API intent, event flow, message pipeline semantics | External repo snapshot at retrieval date |
| `<pi-mono>/packages/agent/src/types.ts` | canonical | high | Type-level contracts for `AgentLoopConfig`, events, and tools | Source of truth for interfaces |
| `<pi-mono>/packages/agent/src/agent.ts` | canonical | high | Runtime semantics for `prompt`, `continue`, queueing, state transitions | Source of truth for behavior |
| `<pi-mono>/packages/agent/src/agent-loop.ts` | canonical | high | Loop/event ordering and transform/convert call boundary | Source of truth for loop behavior |
| `<pi-mono>/packages/agent/src/proxy.ts` | canonical | medium | Proxy streaming model and error path behavior | Focused on proxy mode only |
| `<pi-mono>/packages/agent/CHANGELOG.md` | secondary | medium | Migration/renaming guidance and breaking changes | Historical summaries, validate against source |
| `<pi-mono>/packages/agent/test/agent.test.ts` | canonical | high | Concurrency/queue/continue edge-case behavior | Test-backed behavioral assertions |
| `<pi-mono>/packages/agent/test/agent-loop.test.ts` | canonical | high | transform/convert ordering, event semantics | Test-backed behavioral assertions |
| `specs/harness-agent-spec.md` | canonical | high | Consumer-side integration contract in junior runtime | Repo-local runtime spec |
| `packages/junior/src/chat/respond.ts` | canonical | high | Real-world Pi streaming bridge and timeout handling pattern | Consumer implementation snapshot |
| `packages/junior/src/chat/runtime/streaming.ts` | canonical | high | `AsyncIterable<string>` bridge behavior | Consumer implementation snapshot |

## Decisions

| Decision | Status | Evidence |
| --- | --- | --- |
| Classify skill as `integration-documentation` | adopted | `mode-selection.md` + user goal ("using Pi in another library") |
| Keep skill focused on consumer integration (not authoring internals) | adopted | User request + `harness-agent-spec.md` + `respond.ts` |
| Make event-stream bridge (`message_update`/`text_delta`) a primary guardrail | adopted | `AGENTS.md`, `README.md`, `respond.ts` |
| Require explicit queue/concurrency guidance (`steer`/`followUp`, `continue`) | adopted | `agent.ts`, tests, changelog |
| Include migration checks for renamed APIs | adopted | `CHANGELOG.md`, `agent.ts`, `types.ts` |
| Add proxy transport guidance as optional path | adopted | `proxy.ts` + constructor `streamFn` option |
| Add provider-specific model recommendations | rejected | Out of scope for abstraction-level integration skill |

## Coverage matrix

| Dimension | Coverage status | Evidence |
| --- | --- | --- |
| API surface and behavior contracts | complete | `types.ts`, `agent.ts`, `agent-loop.ts`, `README.md` |
| Config/runtime options | complete | `agent.ts` options + `README.md` options sections |
| Common downstream use cases | complete | `respond.ts`, `streaming.ts`, `harness-agent-spec.md`, tests |
| Known issues/failure modes with workarounds | complete | `agent.test.ts`, `agent-loop.test.ts`, changelog fixes |
| Version/migration variance | complete | `CHANGELOG.md` breaking/renamed APIs |

## Open gaps

- Add integration examples for browser-only consumers that use `streamProxy` with non-fetch runtimes.
- Expand troubleshooting with provider-specific retry/backoff examples after confirming stable patterns in upstream docs.

## Stopping rationale

Additional retrieval is currently low-yield because:

1. API contracts are already covered by source code and tests in `packages/agent`.
2. Consumer integration patterns are already represented by concrete junior runtime code (`respond.ts`, streaming bridge).
3. Remaining gaps are variant-specific extensions, not blockers for the core integration skill.
