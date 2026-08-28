# Tool Design

## Intent

Model-facing tools should have stable contracts across providers and models. A
tool schema should accept argument shapes that mean the same thing and that
models commonly produce. Fixed validation should still reject contradictory or
unsafe requests.

## Policy

- Treat tool schemas as external input edges, not TypeScript call-site
  conveniences.
- For optional model-facing fields, decide whether the field is omitted-only,
  nullable-as-omitted, or an explicit null command. Encode that choice in the
  schema and in the executor.
- If `null` has the same meaning as omission for a tool field, the schema must
  explicitly allow `null` and the executor must normalize it before applying
  business logic.
- If `null` changes behavior, such as clearing an existing value, document that
  behavior in the field description and cover it at the tool edge.
- Keep semantic contradictions in fixed validation. For example, a nullable
  optional field may be valid for one mode and still rejected for a different
  mode that requires a real value.
- Prefer schema and executor alignment over prompt wording when a provider or
  model may serialize absent optional values differently. Do not restate the
  same tool-selection rule in the system prompt; see `agent-steering.md`.
- Prefer provider identifiers that the product already emits (ids, native
  mentions, permalinks, or internal references) over free-text labels that need
  a workspace scan to resolve. A plain name may resolve only against local known
  state the product already stored. When that local match is missing or
  ambiguous, reject with a repairable tool error that steers the model to an
  id-bearing form or a discovery tool. Do not paginate provider inventory APIs
  to invent completeness for name lookup.
- Author first-party model-facing tools through the local Zod tool helper for
  their runtime edge: `zodTool(...)` for host-owned Junior tools and the plugin
  API's Zod helper for first-party plugin package tools. Do not add new raw
  object tool definitions for first-party tools.
- First-party tools should use structured Zod mode by default. Each
  `outputSchema` describes the tool's canonical successful value. Shared
  optional fields such as `target`, `truncated`, and `continuation` may be
  extended when they carry real tool meaning. Do not add generic `ok`, `status`,
  or `data` envelopes.
- Return every tool-specific payload field once, at the canonical output root.
  Duplicating or generically wrapping the payload increases model context and
  transcript size without adding information.
- Structured Zod tool executors return the schema-shaped details object
  directly. The helper and runtime adapters derive Pi-compatible model content,
  transcript details, telemetry, and success metadata from that one value.
- Use native content Zod mode only for multimodal or provider bridge tools where
  native model content is the contract, such as MCP image output. Native content
  tools do not declare a Junior `outputSchema` and return `{ content }` only.
  The runtime may synthesize generic base transcript details. Provider bridge
  layers own their own tracing and logging before adapting to this content-only
  result shape.
- Runtime adapters own provider-specific wrapping. Do not treat a remote
  provider schema such as an MCP `outputSchema` as the Junior Zod helper's
  structured result schema unless the Junior wrapper itself owns that result
  contract.
- Structured tools may declare `privateTraceResult` when part of their validated
  result is safe to keep in private traces. The projector must select only
  static, public, or otherwise non-conversation data. Omission keeps the default
  metadata-only behavior. Returning `undefined` records no private result.
- Keep reusable tool infrastructure in a `tool-support` module or another
  non-`tools` module owned by that package. In the host runtime this is
  `packages/junior/src/chat/tool-support`. Plugin packages should follow the same
  split locally. Files under any `tools` directory must be concrete tool
  definitions or tool executors, not shared helper modules.
- Keep one first-party tool definition per file under any `tools` directory.
- Write short tool descriptions in plain language. State what the tool does and
  what it returns. Do not name the bot product (the display name is
  configurable). Do not narrate when to call the tool, how it implements the
  work, or other tools to prefer unless that contrast is the contract.
- Put field meaning on the parameter schema with concise `describe()` text. Do
  not repeat parameter shape or value formats in the tool description when the
  shared param already owns that text. Reuse shared param schemas across tools
  that accept the same value kind.
- Define shared param schemas as the required value shape. Mark a field
  optional at the tool input use site with `.optional()` (or
  `.nullable().optional()` when null means omit). Do not ship a separate
  `optional*` export of the same param.
- Prefer direct module imports and real dependencies over optional injected
  ports on tool factories. Add dependency injection only when production code
  needs more than one implementation.
- Keep runtime authority, destination, actor, credential, and durable context
  out of model-facing arguments unless the owning module explicitly allows them.
  See `policies/runtime-boundary-schemas.md`.
- Model-repairable execution failures must use the Pi tool-error channel so the
  agent receives a failed tool result and can correct its call. Throw
  `ToolInputError` or another expected tool error for invalid arguments, missing
  active context, unsupported values, or absent target state.
- Plugin packages use `PluginToolInputError` for the same model-repairable cases.
  A plain `Error` is a system failure. The tool error handler reports plain
  `Error` throws to Sentry.
- Do not throw a plain `Error` for ownership denials, missing targets chosen by
  the model, invalid values the model can correct, or provider lookup misses
  that mean "try another input". Those cases must use `ToolInputError` or
  `PluginToolInputError`.
- Repo lint keeps a baseline of remaining plain `Error` throws under tool
  source paths. New plain `Error` throws fail
  `tool-error-classification:check` unless the baseline is updated for a true
  system, config, or integrity failure.
- Do not return sentinel success payloads such as `{ ok: false, error }` for a
  failed model-facing tool execution. Structured result unions remain valid in
  private helpers and non-agent HTTP handlers.

## Exceptions

- Omitted-only fields are acceptable when a present `null` would be ambiguous,
  unsafe, or meaningfully different from absence.
- Provider-owned MCP tools may expose provider schemas as-is. Junior-owned
  wrappers around those tools should still follow this policy.
