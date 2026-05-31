# Backfill `mcp-tool-runtime`

## Why

Junior exposes MCP servers as dynamically activated provider tools. The runtime must reconcile MCP's protocol-level tool model with Junior's skill loading, plugin manifests, requester-bound authorization, static Pi tool lists, and Slack turn resumability. Today that contract is distributed across the MCP client, tool manager, skill bridge tools, plugin manifest allowlists, auth tests, and eval fixtures. A baseline OpenSpec capability is needed before consolidating canonical specs.

## What Changes

- Add an OpenSpec capability for `mcp-tool-runtime`.
- Specify configured provider catalog behavior, activation triggers, provider-scoped tool naming, allowlist filtering, progressive search, stable dispatch through `callMcpTool`, result conversion, auth interrupts, client lifecycle, and session recovery.
- Record MCP prior art from the official MCP tools and authorization specifications.
- Record current implementation gaps and verification follow-ups without freezing accidental ranking or error-message details.

## Impact

- Affected specs:
  - `plugin-manifest`
  - `plugin-runtime`
  - `skill-runtime`
  - `tool-execution`
  - `oauth-flows`
  - `agent-session-resumability`
  - `agent-prompt`
  - `testing`
  - `eval-testing`
- Affected code evidence:
  - `packages/junior/src/chat/mcp/client.ts`
  - `packages/junior/src/chat/mcp/tool-manager.ts`
  - `packages/junior/src/chat/mcp/errors.ts`
  - `packages/junior/src/chat/tools/skill/search-mcp-tools.ts`
  - `packages/junior/src/chat/tools/skill/call-mcp-tool.ts`
  - `packages/junior/src/chat/tools/skill/mcp-tool-summary.ts`
- Affected verification:
  - Unit tests for client session handling, tool-manager activation, tool summary formatting, and bridge tool input validation.
  - Integration tests for mid-turn MCP activation through Pi and Slack auth resume.
  - Evals for skill-driven provider activation, model-facing tool discovery, exact dispatcher use, and post-auth continuation.
