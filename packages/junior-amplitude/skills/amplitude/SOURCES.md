# Amplitude Skill Sources

Last updated: 2026-07-10

## Source inventory

| Source                                                     | Trust tier            | Confidence | Contribution                                                                                                                                      | Usage constraints                                                                |
| ---------------------------------------------------------- | --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `https://amplitude.com/docs/amplitude-ai/amplitude-mcp`    | canonical             | high       | Hosted MCP endpoints, OAuth behavior, supported analytics surfaces, regional setup, and Amplitude access controls.                                | Treat live MCP schemas as authoritative for tool names and arguments.            |
| `https://github.com/amplitude/mcp-marketplace`             | canonical             | high       | Amplitude-authored agent workflow examples and coverage across charts, dashboards, experiments, funnels, retention, cohorts, taxonomy, and users. | Adapt workflow intent; do not copy provider-specific prompt structure wholesale. |
| `https://github.com/getsentry/junior/issues/810`           | local product context | high       | Required Junior use cases: active users, event segmentation, funnels, retention, saved charts, real-time activity, and user search.               | The issue's REST/CLI options predate the hosted MCP recommendation.              |
| `specs/plugin.md`                                          | local canonical       | high       | Manifest-owned provider integration and host-managed MCP activation model.                                                                        | Junior runtime contract.                                                         |
| `specs/plugin-manifest.md`                                 | local canonical       | high       | Hosted MCP, environment expansion, and strict tool allowlist contract.                                                                            | Junior runtime contract.                                                         |
| `packages/junior/src/chat/tools/skill/search-mcp-tools.ts` | local canonical       | high       | Junior-native progressive provider and tool discovery.                                                                                            | Use instead of Amplitude's progressive-discovery URL.                            |

## Adaptation decisions

- Preserve Amplitude's analytics coverage and live schema authority.
- Replace upstream client-specific commands with Junior's `searchMcpTools` and `callMcpTool` bridge.
- Collapse many upstream workflow skills into one Slack-oriented read-only analytics skill for the initial release.
- Allow only tool names that Amplitude's official MCP reference describes as search, retrieval, or query operations.
- Include the standard server's documented search, retrieval, list, and query tools.
- Omit render, create, update, edit, sync, branch mutation, merge, delete, launch, stop, and configuration workflows.
- Keep provider schemas and tool names out of bundled prose because the MCP server is the current source of truth.

## Retrieval stopping rationale

The official MCP documentation, Amplitude marketplace, issue requirements, and Junior plugin contracts cover authentication, runtime integration, analytics workflows, safety boundaries, and failure handling. Additional REST endpoint documentation would duplicate the live MCP schema and encourage stale tool assumptions.
