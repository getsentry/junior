# Backfill `tool-execution`

## Why

Junior exposes many agent tools, but the cross-cutting execution contract is distinct from each tool family. Tool failures, result normalization, sandbox routing, progress updates, authorization pauses, idempotency, plugin hooks, and observability all affect the agent loop before any Slack/web/sandbox/MCP-specific contract applies.

Backfilling `tool-execution` gives the shared Pi tool boundary one OpenSpec capability, while leaving individual tool semantics to `sandbox-tools`, `slack-tools`, `web-tools`, `skill-runtime`, `mcp-tool-runtime`, and `advisor-tool`.

## What Changes

- Add an OpenSpec capability for shared agent tool execution.
- Specify tool definition metadata, Pi tool wrapping, argument preparation, execution mode forwarding, and status/progress behavior.
- Specify result normalization for structured results, plain values, and sandbox envelopes.
- Specify expected versus unexpected tool failure behavior, including model-repairable tool errors and auth pauses.
- Specify turn-scoped idempotency and artifact-state patching boundaries.
- Record current coverage and verification gaps.

## Impact

- Affected specs:
  - `harness-agent`
  - `agent-execution`
  - `harness-tool-context`
  - `credential-injection`
  - `agent-session-resumability`
  - tool-family specs in Tier 2 and Tier 3
  - `testing`
- Affected code evidence:
  - `packages/junior/src/chat/tools/definition.ts`
  - `packages/junior/src/chat/tools/agent-tools.ts`
  - `packages/junior/src/chat/tools/index.ts`
  - `packages/junior/src/chat/tools/execution/*`
  - `packages/junior/src/chat/tools/idempotency.ts`
  - `packages/junior/src/chat/mcp/tool-manager.ts`
- Affected verification:
  - Unit tests for normalization, sandbox input shaping, tool error handling, and tool wrapping.
  - Integration tests for idempotent side-effect tools and dynamic MCP tool execution.
  - Evals only for model-facing tool-use behavior and repair after expected tool errors.
