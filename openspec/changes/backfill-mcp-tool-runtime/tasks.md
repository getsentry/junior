## 1. Source Inventory

- [x] 1.1 Inspect existing canonical specs and related OpenSpec changes for plugin, skill, auth, resumability, prompt, tool execution, and testing boundaries.
- [x] 1.2 Inspect MCP client, tool manager, bridge tools, tool summary helpers, auth orchestration, and runtime integration code.
- [x] 1.3 Inventory current unit, integration, and eval coverage for MCP activation, search, dispatch, auth resume, and dynamic tool behavior.

## 2. Prior Art Review

- [x] 2.1 Review official MCP tools, schema, and authorization specs.
- [x] 2.2 Compare MCP protocol semantics with Junior's plugin/skill/Pi bridge implementation.
- [x] 2.3 Record where Junior intentionally diverges from protocol surface shape because of Pi static tool-list constraints.

## 3. Spec Authoring

- [x] 3.1 Create the `mcp-tool-runtime` OpenSpec requirements and scenarios.
- [x] 3.2 Record undefined behavior and open questions in the worksheet.
- [x] 3.3 Create the verification map with current test/eval mapping and follow-up gaps.

## 4. Validation

- [x] 4.1 Run `openspec validate backfill-mcp-tool-runtime`.
- [x] 4.2 Record validation notes and deferred verification.
- [x] 4.3 Mark the baseline tracker item complete after validation passes.
