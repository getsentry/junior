# OpenTelemetry Semantics Backfill Worksheet

## Canonical Spec

- New spec: `otel-semantics`
- Existing source: `specs/otel-semantics.md`

## Local Artifacts Reviewed

- `specs/otel-semantics.md`
- `specs/instrumentation.md`
- `specs/logging.md`
- `specs/tracing.md`
- `packages/junior/src/chat/logging.ts`
- `packages/junior/src/chat/usage.ts`
- `packages/junior/src/chat/pi/client.ts`
- `packages/junior/src/chat/pi/traced-stream.ts`
- `packages/junior/src/chat/tools/agent-tools.ts`
- `packages/junior/src/chat/mcp/client.ts`
- `packages/junior/src/chat/mcp/tool-manager.ts`
- `packages/junior/src/chat/sandbox/sandbox.ts`
- `packages/junior/src/chat/sandbox/session.ts`
- `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`
- `packages/junior/src/chat/sandbox/skill-sync.ts`
- `packages/junior/src/chat/sandbox/egress-proxy.ts`
- Current attribute inventory from `rg` over `packages/junior/src` and tests.

## External Sources

- OpenTelemetry semantic conventions: https://opentelemetry.io/docs/specs/semconv/
- OpenTelemetry GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OpenTelemetry messaging conventions: https://opentelemetry.io/docs/specs/semconv/messaging/
- OpenTelemetry HTTP conventions: https://opentelemetry.io/docs/specs/semconv/http/
- OpenTelemetry process attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/process/
- OpenTelemetry MCP attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/

## Current Behavior Summary

- Semantic dotted lowercase keys pass through the logging facade.
- Legacy aliases are normalized to current semantic/app keys.
- Unknown non-semantic keys normalize under `app.*`.
- GenAI, Slack/messaging, HTTP, error, MCP, network/server, process, and sandbox-specific attributes are actively used.
- Several `app.*` namespaces are broad but stable enough for baseline: `app.ai.*`, `app.sandbox.*`, `app.slack.*`, `app.plugin.*`, `app.skill.*`, `app.config.*`, `app.file.*`, `app.message.*`, `app.credential.*`, `app.compaction.*`, `app.web_search.*`.

## Undefined Behavior

| Question                                             | Current Evidence                 | Candidate Decision                                                    | Status |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- | ------ |
| Exhaustive custom key registry                       | Many `app.*` keys exist.         | Namespace families now, full registry later if needed.                | open   |
| Finish reason value normalization                    | Raw Pi values emitted.           | Future cleanup.                                                       | open   |
| HTTP header semantic form                            | Some explicit header keys exist. | Review before adding new header attributes.                           | open   |
| `app.ai.conversation_id` vs `gen_ai.conversation.id` | Both patterns exist.             | Migrate true conversation ids to semantic key when touching handlers. | open   |
| `app.run.id` vs `app.workflow.run_id`                | Specs/code differ.               | Defer migration until dashboard impact is known.                      | open   |

## Migration Notes

- Accepted backfill should make `otel-semantics` the key-naming authority.
- Logging and tracing specs should link here instead of repeating key lists.

## Validation

- `openspec validate backfill-otel-semantics --strict` passed.
