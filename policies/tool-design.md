# Tool Design

## Intent

Model-facing tools need stable contracts across providers and models. A schema
accepts argument shapes that mean the same thing. Fixed validation rejects
contradictory or unsafe requests.

## Policy

### Schemas

- Treat tool schemas as external input edges.
- For each optional field, choose omitted-only, null-as-omitted, or null as a
  command. Encode the choice in the schema and the executor.
- If `null` means omitted, the schema allows `null` and the executor
  normalizes it first.
- If `null` changes behavior (for example, clears a value), say so in the
  field description and test it at the tool edge.
- Keep contradictions in fixed validation, even for nullable fields.
- Fix schema and executor alignment, not prompt text. See `agent-steering.md`.
- Prefer ids, native mentions, permalinks, and internal references over
  free-text names. Resolve a plain name only against stored local state. On a
  miss or ambiguity, throw a repairable tool error that points to an id form
  or a discovery tool. Do not paginate provider inventory to resolve names.
- Keep runtime authority, destination, actor, credentials, and durable context
  out of model arguments. See `runtime-boundary-schemas.md`.

### Authoring

- Author first-party tools with `zodTool(...)` (host) or the plugin API Zod
  helper (plugins). No new raw object tool definitions.
- Use structured mode by default. `outputSchema` describes the canonical
  success value. Shared optional fields (`target`, `truncated`,
  `continuation`) are fine when they carry meaning. No `ok`, `status`, or
  `data` envelopes.
- Return each payload field once, at the output root.
- Structured executors return the schema-shaped object. The helper derives
  model content, transcript details, telemetry, and success metadata.
- Use native content mode only when native model content is the contract (for
  example, MCP images). It has no `outputSchema` and returns `{ content }`.
  Provider bridges own their tracing before they adapt to this shape.
- Runtime adapters own provider wrapping. A remote schema such as an MCP
  `outputSchema` is not the Junior result schema unless the Junior wrapper owns
  it.
- `privateTraceResult` may select only static, public, or non-conversation
  data. Omit it for metadata-only traces. Return `undefined` to record nothing.
- Put shared tool infrastructure in `tool-support` (host:
  `packages/junior/src/chat/tool-support`) or another non-`tools` module.
  Files under `tools` are concrete tools only, one tool per file.
- Prefer direct imports over injected ports. Inject only when production needs
  more than one implementation.

### Descriptions and params

- Tool descriptions are short and plain: what it does and returns. Do not name
  the bot. Do not narrate when to call it, how it works, or which tool to
  prefer unless that contrast is the contract.
- Put field meaning in `describe()` on the param. Do not repeat it in the tool
  description. Reuse shared param schemas for the same value kind.
- Shared params define the required shape. Add `.optional()` or
  `.nullable().optional()` at the use site. No `optional*` exports.

### Errors

- Model-repairable failures use the Pi tool-error channel: `ToolInputError`
  (host) or `PluginToolInputError` (plugins). This covers invalid arguments,
  missing active context, unsupported values, absent targets, ownership
  denials, and provider lookup misses.
- A plain `Error` is a system failure and goes to Sentry.
- `tool-error-classification:check` keeps a baseline of plain `Error` throws in
  tool sources. Extend it only for true system, config, or integrity failures.
- Do not return `{ ok: false, error }` from a model-facing tool. Result unions
  are fine in private helpers and non-agent HTTP handlers.

## Exceptions

- Omitted-only fields are fine when a present `null` is ambiguous or unsafe.
- Provider-owned MCP tools may expose provider schemas as-is. Junior wrappers
  around them follow this policy.
