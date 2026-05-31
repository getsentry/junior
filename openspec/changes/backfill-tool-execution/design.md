# Design: `tool-execution`

## Scope

`tool-execution` owns the shared boundary between Pi `AgentTool` calls and Junior tool definitions. It starts when a tool is registered for an agent turn and ends when the Pi agent receives a tool result or tool error.

It does not own the behavior of each concrete Slack, web, sandbox, skill, MCP, advisor, or provider tool beyond the shared execution contract.

## Current Boundary

- `definition.ts` defines local tool metadata and execution hooks.
- `index.ts` assembles turn-scoped tool instances from skills, runtime context, channel capabilities, MCP state, advisor state, and plugin hooks.
- `agent-tools.ts` wraps local definitions as Pi `AgentTool` objects with progress handling, sandbox routing, plugin hooks, normalization, auth-pause propagation, and tracing.
- `execution/normalize-result.ts` converts arbitrary tool return values into Pi-compatible content/details.
- `execution/tool-error-handler.ts` classifies expected versus unexpected tool failures.
- `idempotency.ts` builds deterministic operation keys for turn-scoped side-effect dedupe.

## Design Decisions

### Use Pi's tool-result channel for repairable failures

Model-repairable failures must be thrown as expected tool errors so Pi records a `toolResult` with error state and the model can repair the call. Returning `{ ok: false }` as a successful tool result hides failure semantics from the agent loop.

Successful structured results may still represent negative domain data, such as an empty search result or an advisory sub-agent being unavailable when that tool family explicitly defines the result as non-fatal. Those are exceptions to classify deliberately, not a general escape hatch for failed tool execution.

### Keep auth interrupts separate from ordinary tool errors

Authorization pauses are lifecycle interrupts. They must propagate to the runtime/session layer instead of being converted into a model-repairable tool error. Once auth pause has been requested, placeholder results may be used only to let an already-aborted turn park cleanly without a spurious visible failure.

### Normalize all successful outputs

Tools may return structured Pi content/details or simple values. The wrapper must normalize successful outputs into content/details so the model sees consistent text/image content while diagnostics and hooks can still inspect structured details.

### Route sandbox-capable tools through the sandbox executor

When a sandbox executor owns a tool name, the wrapper should normalize tool arguments into the sandbox executor shape and execute there instead of calling the host implementation. Host credential injection and sandbox credential handling remain separate credential specs.

### Keep idempotency turn-scoped

Side-effect dedupe uses turn-local tool state and deterministic operation keys. It prevents repeat identical actions within a turn, but it is not a durable exactly-once guarantee across retries, resumed turns, or separate sessions unless a tool-family spec adds that guarantee.

## Risks

- Some concrete tools still need classification: repairable failures should become expected tool errors, while true negative domain results should be documented by their tool-family specs.
- Tool error coverage is strong for the handler but weaker for end-to-end Pi repair behavior.
- Plugin/MCP auth pauses have special parking behavior that must remain aligned with session-resumability and OAuth specs.
- Sandbox input shaping is intentionally minimal and could drift from sandbox executor schemas.

## Open Questions

1. Which existing concrete `{ ok:false }` results are repairable failures that must become `ToolInputError` or family-specific expected errors, and which are legitimate negative domain results?
2. Should expected tool errors be verified end-to-end through Pi message history, not just handler classification?
3. Should turn-scoped idempotency become durable for specific high-risk Slack/provider tools?
4. Should plugin hook environment mutation be specified here or in plugin-runtime?
