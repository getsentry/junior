# Backfill Worksheet: `mcp-tool-runtime`

## Scope

- Capability: MCP tool runtime
- Change: `backfill-mcp-tool-runtime`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/mcp-tool-runtime/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/plugin-manifest.md`: plugin manifest MCP declarations, provider identity, and allowlist ownership.
- `specs/plugin-runtime.md`: plugin discovery/loading and runtime boundaries.
- `specs/skill-runtime.md`: skill loading and `pluginProvider` activation boundary.
- `specs/tool-execution.md`: shared tool execution, expected tool failures, and repairability contract.
- `specs/oauth-flows.md`: OAuth callback and Slack UX ownership.
- `specs/agent-session-resumability.md`: parked turn lifecycle and resume projection.
- `specs/agent-prompt.md`: prompt/tool disclosure and model instructions.
- `specs/testing.md` and `specs/eval-testing.md`: verification layer selection.

### Code Paths

- `packages/junior/src/chat/mcp/client.ts`: SDK client wrapper, streamable HTTP transport, paginated `listTools`, `callTool`, auth challenge wrapping, server session ID persistence, and missing-session retry.
- `packages/junior/src/chat/mcp/tool-manager.ts`: configured provider catalog, lazy activation, allowlist filtering, provider-prefixed names, result conversion, auth-pending state, active tool catalog, and close cleanup.
- `packages/junior/src/chat/mcp/errors.ts`: `McpToolError` and MCP-aware logging/error attribute helpers.
- `packages/junior/src/chat/tools/skill/search-mcp-tools.ts`: progressive provider/tool catalog search and optional provider activation.
- `packages/junior/src/chat/tools/skill/call-mcp-tool.ts`: stable dispatcher by exact canonical tool name and nested `arguments`.
- `packages/junior/src/chat/tools/skill/mcp-tool-summary.ts`: model-facing signature, call example, schema summary, and active provider summaries.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/mcp/client.test.ts`
  - `packages/junior/tests/unit/mcp/tool-manager.test.ts`
  - `packages/junior/tests/unit/mcp/auth-store.test.ts`
  - `packages/junior/tests/unit/mcp/oauth-provider.test.ts`
  - `packages/junior/tests/unit/tools/search-mcp-tools.test.ts`
  - `packages/junior/tests/unit/tools/call-mcp-tool.test.ts`
  - `packages/junior/tests/unit/runtime/respond-mcp-progressive-loading.test.ts`
- Integration:
  - `packages/junior/tests/integration/mcp-dynamic-tools.test.ts`
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
  - `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
- Evals and fixtures:
  - MCP auth eval fixture paths under `packages/junior-evals`.
  - Provider skills that exercise MCP-backed tool discovery and dispatch.

## Prior Art

- MCP tools are a model-controlled server feature. Clients discover tools with `tools/list`, invoke them with `tools/call`, and receive content plus optional structured output.
- MCP tool definitions include `name`, optional `title`, `description`, `inputSchema`, optional `outputSchema`, and annotations. Tool annotations are hints and must not be over-trusted unless the server is trusted.
- MCP tool results distinguish protocol errors from tool execution errors; execution errors are returned as normal tool results with `isError: true`.
- MCP HTTP authorization is transport-level OAuth. Clients respond to authorization challenges outside the model loop and use tokens to access protected MCP resources.

Sources:

- MCP Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP Authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- MCP Schema Reference: https://modelcontextprotocol.io/specification/2025-06-18/schema

## Implemented Behavior

- Behavior that code currently enforces:
  - Only plugin providers with manifest MCP declarations are included in the configured MCP provider catalog.
  - Provider catalog reads are cheap and do not connect to remote MCP servers.
  - Provider activation is lazy and can be triggered by skill loading, provider-scoped `searchMcpTools`, or canonical-name `callMcpTool`.
  - Provider activation lists tools, applies `mcp.allowedTools`, fails if an allowlisted tool is missing, and caches a `PluginMcpClient`.
  - Model-facing MCP names are `mcp__<provider>__<rawName>`.
  - `searchMcpTools` searches active tools and configured providers; with `provider`, it activates the provider and returns descriptor summaries including signatures and exact `callMcpTool` shapes.
  - `callMcpTool` parses provider from canonical names, activates configured inactive providers, rejects extra top-level fields, requires object-shaped nested `arguments`, and dispatches by exact active tool name.
  - `PluginMcpClient` handles paginated `tools/list`, sorted cached tool discovery, `tools/call`, auth challenge wrapping, streamable HTTP server session ID persistence, and missing-session retry.
  - MCP text/image results become Pi text/image content; audio/resources/resource links/structured content become text summaries when needed.
  - MCP `isError: true` results raise `McpToolError`; auth challenges delegate to an authorization handler.
  - If auth handling parks the turn, the provider becomes authorization-pending and is removed from active tools/clients to avoid repeated prompts in the same slice.
- Behavior that tests currently verify:
  - Collision-safe names, activation idempotency, allowlist filtering, missing allowlist failure, active/inactive provider catalog, expected MCP tool errors, auth challenge parking, close cleanup.
  - `searchMcpTools` schema exposure, provider listing without connection, provider-scoped active tool listing, and result limits.
  - `callMcpTool` exact dispatch, nested argument enforcement, invalid nested args, and inactive tool rejection.
  - Pi can progress through MCP dynamic discovery using static bridge tools.
  - Slack auth resume retains prior context and can continue into MCP search/dispatch after callback.
- Behavior that appears accidental or weakly enforced:
  - Generic `Error` is used for several repairable input failures rather than a dedicated repairable tool error type.
  - Search ranking weights are implementation heuristics and should not become product guarantees.
  - Client-side `outputSchema` validation is not implemented.
  - `notifications/tools/list_changed` is not modeled as a cache invalidation signal.
  - Resource/blob text summaries are not currently governed by a dedicated token/byte budget in this spec.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - MCP providers are lazily activated and scoped to a turn/runtime manager.
  - Configured providers can be suggested without remote connection.
  - Canonical tool names are provider-prefixed and exact.
  - The model must discover MCP tools through `searchMcpTools` and dispatch through `callMcpTool`.
  - Authorization is a runtime interrupt recorded/resumed through auth/session specs, not a prompt flag.
  - MCP `isError` tool results are expected tool failures that should be repairable by the model.
  - Raw MCP result details remain available for diagnostics while model-facing content is Pi-compatible.
- Behavior that should remain implementation detail:
  - Exact search scoring weights.
  - Exact default `max_results`.
  - Exact logging event names and span attributes.
  - Exact MCP SDK classes used under the client wrapper.
- Behavior that should be non-goal:
  - Exposing every MCP tool as a top-level Pi tool at agent initialization.
  - Implementing MCP prompts/resources roots/sampling/elicitation as part of this capability.
  - OAuth token storage details.
  - Slack public/private auth message formatting.

## Undefined Behavior / Open Questions

| Question                                                        | Evidence                                                                                      | Options                                                                                   | Recommendation                                   | Status |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| Should local `callMcpTool` input failures use `ToolInputError`? | Current bridge throws generic `Error`; `tool-execution` prefers repairable expected failures. | Convert to `ToolInputError`, keep generic, or wrap at tool boundary.                      | Align after tool-family error audit.             | open   |
| Should missing allowlisted tools hard-fail activation?          | Current tool-manager throws if an allowlisted tool is absent.                                 | Hard fail, partial activation with health warning, or manifest validation during install. | Keep hard fail until provider/runtime UX review. | open   |
| Should MCP `outputSchema` be client-validated?                  | MCP says clients should validate; current runtime passes through.                             | Validate always, validate trusted providers only, or leave provider-owned.                | Decide with plugin trust policy.                 | open   |
| Should `notifications/tools/list_changed` invalidate caches?    | MCP supports list-changed notifications; current client caches listed tools.                  | Ignore, invalidate per session, or reconnect.                                             | Defer until long-lived MCP sessions require it.  | open   |
| What budget applies to resource/blob summaries?                 | Current conversion includes text resources verbatim and binary encoded size.                  | Dedicated budget, shared tool output budget, or provider trust.                           | Use shared tool output budget when specified.    | open   |
| Can provider names contain the canonical delimiter?             | `callMcpTool` parses `mcp__<provider>__<tool>` by first delimiter.                            | Forbid `__` in provider names, escape names, or accept ambiguity.                         | Enforce in plugin manifest spec.                 | open   |

## OpenSpec Requirements Draft

| Requirement                       | Scenarios                                                                             | Source Evidence                              | Notes                            |
| --------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| Configured MCP provider catalog   | no MCP declaration, inactive catalog, active ordering                                 | tool-manager, plugin manifest                | No remote connection.            |
| MCP provider activation           | skill/provider/call activation, idempotency, pending auth, allowlist missing          | tool-manager tests                           | Lazy activation.                 |
| MCP tool descriptor normalization | canonical names, metadata, collisions, call shape                                     | tool-manager, summary helper, MCP tools spec | Provider prefix is local design. |
| Progressive MCP tool search       | omitted provider, provider activation, no query, query, limits                        | search tool/tests                            | Ranking details non-normative.   |
| Exact MCP tool dispatch           | exact name, omitted args, top-level args, non-object args, inactive tool              | call tool/tests, MCP tools spec              | Stable bridge.                   |
| MCP result conversion             | text, image, audio, resource link, embedded resource, structured fallback, raw result | tool-manager, MCP schema                     | Pi-compatible content.           |
| MCP errors and auth interrupts    | `isError`, auth challenge, parked auth, unhandled auth, missing session, close        | client/tool-manager/tests, MCP auth spec     | Auth lifecycle cross-spec.       |
| Verification taxonomy             | unit, integration, auth resume, eval                                                  | tests/evals/testing specs                    | Layer map.                       |

## Migration Notes

- Canonical spec updates:
  - Add `mcp-tool-runtime` to the spec index after acceptance.
  - Cross-link from `plugin-runtime`, `plugin-manifest`, `skill-runtime`, `oauth-flows`, and `agent-session-resumability`.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Keep MCP auth callback/token details in auth specs.
  - Keep plugin manifest field validation in plugin manifest specs.
- Test/eval taxonomy changes:
  - Keep deterministic tool-manager/client/bridge behavior in unit tests.
  - Keep Pi/Slack wiring and auth resume in integration tests.
  - Keep model choice, discovery, and continuation behavior in evals.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-mcp-tool-runtime' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: repairable input error shape, allowlist-missing UX, output-schema validation, list-changed cache invalidation, resource/blob budgets, and provider delimiter validation.
