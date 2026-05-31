## Context

`otel-semantics` is the naming authority for attributes used by both logs and spans. It does not decide which events or spans are emitted; that belongs to `logging` and `tracing`. It decides which key names are valid, when OpenTelemetry semantic conventions are preferred, and how repo-specific data is represented under `app.*`.

The current implementation normalizes attribute keys in `logging.ts`, maps several legacy names to current semantic keys, and emits many `app.*` attributes across Slack, sandbox, OAuth, compaction, plugins, tools, and runtime workflows.

## Prior Art

- OpenTelemetry semantic conventions overview and stability guidance: https://opentelemetry.io/docs/specs/semconv/
- OpenTelemetry GenAI semantic conventions define `gen_ai.*` operation, request, response, tool, and usage attributes: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OpenTelemetry messaging semantic conventions define messaging system, destination, and message attributes used for Slack context: https://opentelemetry.io/docs/specs/semconv/messaging/
- OpenTelemetry HTTP semantic conventions define request/response and URL attributes: https://opentelemetry.io/docs/specs/semconv/http/
- OpenTelemetry process attributes define process execution keys used by sandbox bash spans: https://opentelemetry.io/docs/specs/semconv/registry/attributes/process/
- OpenTelemetry MCP attributes define MCP/JSON-RPC/network/server keys for MCP tool calls: https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/

## Local Evidence

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
- `packages/junior/tests/unit/logging/extract-gen-ai-usage-summary.test.ts`
- `packages/junior/tests/unit/logging/with-span.test.ts`
- `packages/junior/tests/unit/chat/pi/traced-stream.test.ts`
- `packages/junior/tests/unit/pi/client.test.ts`
- `packages/junior/tests/unit/tools/agent-tools.test.ts`
- `packages/junior/tests/unit/mcp/client.test.ts`
- `packages/junior/tests/unit/mcp/tool-manager.test.ts`

## Behavior Extraction

- Semantic keys are accepted as-is when they match dotted lowercase semantic-key form.
- Legacy keys are normalized by `LEGACY_KEY_MAP`, including:
  - `gen_ai.system` -> `gen_ai.provider.name`
  - `gen_ai.request.messages` -> `gen_ai.input.messages`
  - `gen_ai.response.text` -> `gen_ai.output.messages`
  - `messaging.conversation.id` -> `messaging.message.conversation_id`
  - `finishReason` -> `gen_ai.response.finish_reasons`
  - `attempt` -> `app.retry.attempt`
- Non-semantic keys normalize to `app.<snake_case>`.
- `LogContext` maps conversation, Slack channel/thread/user, run, actor, model, skill, HTTP path, URL, and user agent fields to current semantic or app keys.
- GenAI usage extraction maps Pi usage into `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, and `gen_ai.usage.cache_creation.input_tokens`.
- MCP client/tool code uses `mcp.method.name`, `mcp.protocol.version`, `mcp.session.id`, `jsonrpc.*`/`rpc.*` where available, `network.*`, `server.*`, and `gen_ai.tool.*`.
- Sandbox process spans use `process.executable.name`, `process.exit.code`, and `app.sandbox.*` custom keys for sandbox-specific data.
- HTTP/server/request code uses `http.request.method`, `http.response.status_code`, `url.path`, `url.full`, and selected safe header keys.

## Open Questions / Undefined Behavior

| Question                                                                   | Current Evidence                                                                         | Candidate Decision                                                                                      | Status |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| Should all existing `app.*` keys be enumerated?                            | Current repo has many `app.*` keys across domains.                                       | Enumerate namespace families now; exact key registry can be added when dashboard ownership requires it. | open   |
| Are `gen_ai.response.finish_reasons` values canonical?                     | Pi tracing comment says raw Pi values may differ from OTel canonical values.             | Track as a cleanup gap; do not block baseline.                                                          | open   |
| Should HTTP header attributes use OTel header list conventions?            | Some current keys use `http.request.header.x_slack_signature` and response header keys.  | Keep safe explicit keys; review against current OTel header convention before expanding.                | open   |
| Should `app.ai.conversation_id` be normalized to `gen_ai.conversation.id`? | Some handlers emit `app.ai.conversation_id`; `LogContext` uses `gen_ai.conversation.id`. | Candidate migration to semantic key where values are true conversation ids.                             | open   |
| Should `app.run.id` become `app.workflow.run_id`?                          | Prose specs mention `app.workflow.run_id`; code uses `app.run.id`.                       | Defer until dashboards and code can migrate together.                                                   | open   |

## Decisions

### Decision: Semantic-first, `app.*` second

OpenTelemetry keys are preferred even when conventions are in development status. `app.*` exists for repo-specific concepts that have no suitable semantic key.

### Decision: Semantics map owns names, not emission timing

This capability decides key names and alias migration. `logging` and `tracing` decide when those keys are emitted.

### Decision: Namespace families are enough for baseline

The baseline requires coherent `app.*` families and open-question tracking. A complete registry of every custom key is deferred until there is a concrete dashboard or alert ownership need.

## Verification Strategy

- Unit tests verify core GenAI usage key mapping, span context mapping, MCP method annotation, tool span keys, and Pi chat keys.
- Logging/tracing backfills own record/span emission tests.
- Attribute inventory can be audited with `rg` when reviewing major telemetry changes.
- New custom key families should be reviewed in specs before widespread use.
