# Design: `mcp-tool-runtime`

## Goals

- Define how Junior makes MCP provider tools available without exposing every remote tool as a top-level Pi tool.
- Preserve MCP protocol semantics for tool discovery, tool invocation, result content, structured output, and `isError` failures.
- Keep authorization as a host/runtime interrupt rather than prompt state.
- Separate normative product behavior from current ranking heuristics and implementation-specific provider details.

## Non-Goals

- Specify plugin manifest parsing in full; this capability consumes provider MCP declarations.
- Specify OAuth callback validation, token storage, or Slack private-message delivery in full; those belong to auth specs.
- Specify final-answer wording or source/citation quality.
- Require support for MCP prompts, resources, roots, sampling, or elicitation.

## Prior Art Summary

The official MCP tools spec defines model-controlled tools discovered with `tools/list` and invoked with `tools/call`. Tool definitions include a unique tool name, optional title, description, `inputSchema`, optional `outputSchema`, and annotations; tool results can include text, image, audio, resource links, embedded resources, and `structuredContent`. The MCP spec distinguishes protocol errors from tool execution errors; tool execution failures are represented with `isError: true`.

The official MCP authorization spec treats authorization as transport-level OAuth for HTTP transports. Junior therefore treats a 401/authorization challenge as a runtime interrupt that parks and later resumes the turn, not as a model-authored question or a durable prompt flag.

Sources:

- MCP Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP Authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- MCP Schema Reference: https://modelcontextprotocol.io/specification/2025-06-18/schema

## Decisions

### Provider Activation Is Explicit And Lazy

Configured MCP providers are discoverable without connecting to remote MCP servers. Junior connects only when a skill's `pluginProvider` activates a provider, `searchMcpTools` is called with a configured provider, or `callMcpTool` names a configured provider.

### Model-Facing Names Are Provider-Prefixed

Raw MCP tool names are provider-scoped. Junior exposes canonical names as `mcp__<provider>__<rawToolName>` to avoid collisions when multiple providers are active in the same turn. The raw MCP name remains the value sent to `tools/call`.

### Progressive Disclosure Uses Stable Bridge Tools

Pi's initial tool list stays stable: `loadSkill`, `searchMcpTools`, and `callMcpTool` are the bridge surface. `searchMcpTools` discloses provider catalogs and exact schemas; `callMcpTool` dispatches by the exact disclosed canonical name. Dynamically discovered MCP tools are not injected as new top-level Pi tools mid-run.

### Authorization Is A Runtime Interrupt

When connection, discovery, or invocation needs authorization, the MCP runtime delegates to the authorization handler. If the handler parks the turn, the provider is marked pending, active tools are removed, and the tool call returns only the minimal placeholder needed for Pi to park cleanly. Completion and resume are owned by session resumability and OAuth specs.

### Result Conversion Preserves Model-Useful Content

Text and image content are passed through. Audio, resource links, embedded binary resources, and `structuredContent` are converted to bounded text summaries for the model. Raw MCP results remain in tool details for diagnostics.

## Open Design Questions

- Whether all local `callMcpTool` input failures should use `ToolInputError` instead of generic `Error`.
- Whether allowlisted MCP tools missing from discovery should hard-fail activation or degrade by hiding the missing tools and reporting provider health separately.
- Whether `notifications/tools/list_changed` should invalidate cached tool catalogs during long sessions.
- Whether MCP `outputSchema` validation should be performed client-side or left to provider trust and tests.
- Whether resource/blob summaries need stricter byte budgets before entering Pi context.
