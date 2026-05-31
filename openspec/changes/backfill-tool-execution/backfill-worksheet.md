# Backfill Worksheet: `tool-execution`

## Scope

- Capability: Tool execution
- Change: `backfill-tool-execution`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/tool-execution/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/agent-execution.md`: owns repository coding-agent discipline and the repairable tool-failure policy.
- `specs/harness-agent.md`: owns Pi agent loop, tool/result visibility, terminal output, and diagnostics.
- `specs/harness-tool-context.md`: owns context-bound tool targeting and missing-context failure behavior.
- `specs/agent-session-resumability.md`: owns auth/timeout pause lifecycle after tool execution interrupts a turn.
- `specs/credential-injection.md`: owns requester-bound credential availability and sandbox credential injection.
- `specs/testing.md`: owns unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/tools/definition.ts`: local tool metadata, schemas, prompt snippets, argument preparation, execution mode, and execute function shape.
- `packages/junior/src/chat/tools/index.ts`: turn-scoped tool assembly, artifact state, operation-result cache, channel capability gating, MCP/advisor/plugin tool inclusion, and plugin conflict detection.
- `packages/junior/src/chat/tools/agent-tools.ts`: Pi wrapper, progress handling, plugin before-tool hooks, sandbox routing, result normalization, credential-failure handling, auth interrupt propagation, and span attributes.
- `packages/junior/src/chat/tools/execution/normalize-result.ts`: structured/plain/sandbox result normalization.
- `packages/junior/src/chat/tools/execution/build-sandbox-input.ts`: sandbox input shaping for shell/file/search tools.
- `packages/junior/src/chat/tools/execution/tool-error-handler.ts`: expected/unexpected tool error classification and logging/reporting behavior.
- `packages/junior/src/chat/tools/execution/tool-input-error.ts`: model-repairable tool input error type.
- `packages/junior/src/chat/tools/idempotency.ts`: deterministic operation-key serialization.
- `packages/junior/src/chat/mcp/tool-manager.ts`: MCP tool error conversion and auth-pending placeholder behavior.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/tools/execution/normalize-result.test.ts`
  - `packages/junior/tests/unit/tools/execution/build-sandbox-input.test.ts`
  - `packages/junior/tests/unit/tools/execution/tool-error-handler.test.ts`
  - `packages/junior/tests/unit/tools/agent-tools.test.ts`
  - `packages/junior/tests/unit/tools/channel-capabilities.test.ts`
  - `packages/junior/tests/unit/mcp/tool-manager.test.ts`
- Integration:
  - `packages/junior/tests/integration/tool-idempotency.test.ts`
  - `packages/junior/tests/integration/mcp-dynamic-tools.test.ts`
  - `packages/junior/tests/integration/advisor/advisor-tool.test.ts`
  - Slack/web/sandbox tool-family integration tests.
- Evals:
  - Tool-use behavior evals belong to agent/tool-family capabilities when natural-language repair or selection is the contract.

## Prior Art

- Pi Agent treats tool calls and tool results as internal execution artifacts. User-visible replies are resolved from assistant text, not raw tool results.
- Pi integration guidance says tool execution and turn lifecycle events remain internal unless product UX explicitly exposes them.
- The repository's execution policy requires repairable tool failures to throw expected tool errors so Pi records `toolResult.isError=true` and the model can repair the call.

## Implemented Behavior

- Behavior that code currently enforces:
  - Tool metadata is forwarded into Pi `AgentTool` objects.
  - `prepareArguments` and `executionMode` are forwarded unchanged.
  - Tools without an execute function return a successful no-op result.
  - `reportProgress` updates assistant status; ordinary tool calls do not synthesize status.
  - Plugin before-tool hooks can rewrite tool input before execution.
  - Sandbox-capable tools are executed through the sandbox executor with normalized input.
  - Sandbox result envelopes are unwrapped before normalization.
  - Structured content/details results pass through; plain values become single text content parts with original details preserved.
  - Expected tool errors include `ToolInputError`, MCP tool errors, and plugin input errors.
  - Unexpected errors are logged/reported as exceptions.
  - Authorization pause and disabled-auth errors bypass normal tool error handling.
  - MCP auth-pending flow can return a placeholder result after the pause is requested.
  - Operation keys are stable across object key ordering.
  - Tool state supports turn-local side-effect dedupe and artifact patches.
- Behavior that tests currently verify:
  - Result normalization for sandbox envelopes, structured output, strings, objects, and null.
  - Tool error handler distinguishes system errors from `ToolInputError` and `McpToolError`.
  - Agent-tool wrapper handles progress, sandbox bash routing, tool-call parameter callbacks, Pi metadata forwarding, span attributes, raw MCP result observability, and auth error propagation.
  - Side-effect idempotency deduplicates repeated canvas/list operations within one turn.
  - Dynamic MCP tests verify runtime exposure and result behavior.
- Behavior that appears accidental or weakly enforced:
  - Existing concrete tools still need classification where they return `{ ok: false }`: repairable failure cases should throw expected tool errors, while legitimate negative domain results should be explicitly specified by the owning tool-family spec.
  - End-to-end proof that Pi records expected thrown errors as model-repairable tool-result error frames is indirect.
  - Plugin hook environment mutation is not clearly specified at this capability boundary.
  - Idempotency is turn-local, but some side effects may need stronger durable guarantees later.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Shared wrapper preserves Pi tool semantics.
  - Repairable failures are expected thrown tool errors, not successful sentinel payloads.
  - Auth pauses are lifecycle interrupts.
  - Successful tool outputs are normalized consistently.
  - Sandbox routing is explicit and does not accidentally run host tools when sandbox owns them.
  - Side-effect dedupe is available within a turn.
- Behavior that should remain implementation detail:
  - Exact span/log event names outside instrumentation specs.
  - Exact order of tool registration except where conflicts/gating matter.
  - Exact operation cache data structure.
  - Exact JSON formatting of serialized plain object result text.
- Behavior that should be non-goal:
  - Slack/web/sandbox/MCP/advisor-specific tool semantics.
  - Provider credential lease policy.
  - Natural-language tool selection quality.
  - Durable exactly-once side-effect guarantees unless a tool family opts in.

## Undefined Behavior / Open Questions

| Question                                                      | Evidence                                                                                                                             | Options                                                                                           | Recommendation                                                                                                                                        | Status |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Which `{ ok:false }` results are failures versus domain data? | Agent-execution says repairable failures must throw; advisor has an explicit non-fatal result contract; tool family behavior varies. | Convert repairable failures, document legitimate negative results, or carve out named exceptions. | Audit by tool family; convert missing context/invalid input to expected tool errors; document advisor and true no-result/read outcomes as exceptions. | open   |
| Should expected tool-error repair be covered by evals?        | Handler tests classify errors, but Pi repair loop is model-facing.                                                                   | Unit, Pi integration, eval, or split.                                                             | Split: Pi integration for error frame, eval for natural-language repair.                                                                              | open   |
| Should idempotency be durable?                                | Current operation cache is turn-local.                                                                                               | Keep turn-local, per-tool durable, or global.                                                     | Keep turn-local here; decide per side-effect family.                                                                                                  | open   |
| Where do plugin hook env mutations belong?                    | `beforeToolExecute` can return env, but wrapper mostly uses input.                                                                   | Tool-execution, plugin-runtime, or credential spec.                                               | Defer to plugin-runtime unless env affects shared wrapper semantics.                                                                                  | open   |

## OpenSpec Requirements Draft

| Requirement                         | Scenarios                                           | Source Evidence                        | Notes                          |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------- | ------------------------------ |
| Tool definition registration        | schema/description, prepare args, mode, no execute  | `definition.ts`, `agent-tools.test.ts` | Pi surface.                    |
| Turn-scoped tool assembly           | core, channel gating, MCP absent, plugin conflict   | `index.ts`, channel capability tests   | Family semantics elsewhere.    |
| Tool hook and progress handling     | progress, non-progress, hook rewrite                | `agent-tools.ts`, tests                | Status is runtime progress.    |
| Sandbox execution routing           | sandbox yes/no, envelope                            | `agent-tools.ts`, build-sandbox tests  | Sandbox semantics later.       |
| Successful result normalization     | structured, string, JSON, image                     | `normalize-result.ts`, tests           | Pi content/details.            |
| Expected tool failure semantics     | invalid input, MCP error, plugin input, no sentinel | `agent-execution.md`, handler tests    | Core policy.                   |
| Unexpected tool failure handling    | system error, expected error, Slack attributes      | `tool-error-handler.ts`                | Instrumentation-adjacent.      |
| Authorization interrupt propagation | pause, disabled, placeholder                        | `agent-tools.ts`, MCP manager          | Session-resume owns lifecycle. |
| Turn-scoped side-effect idempotency | stable key, repeated op, new turn                   | `idempotency.ts`, integration tests    | Not durable.                   |
| Verification taxonomy               | unit, integration, eval/Pi                          | testing spec                           | Keeps scope clean.             |

## Migration Notes

- Canonical spec updates:
  - Add `tool-execution` to index after acceptance.
  - Narrow generic tool-failure prose in `agent-execution` to point here after canonicalization.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Keep coding-agent discipline in `agent-execution`; move shared runtime tool execution contract here.
- Test/eval taxonomy changes:
  - Map model-repair evals separately from deterministic wrapper tests during eval taxonomy migration.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-tool-execution' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: sentinel failure audit, end-to-end Pi repair behavior, durable idempotency decision, and plugin hook env boundary.
