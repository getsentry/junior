# Tool Design

## Intent

Model-facing tools should have stable contracts across providers and models. A
tool schema should accept semantically equivalent argument shapes that models
commonly produce, while deterministic validation should still reject
contradictory or unsafe requests.

## Policy

- Treat tool schemas as external input boundaries, not TypeScript call-site
  conveniences.
- For optional model-facing fields, decide whether the field is omitted-only,
  nullable-as-omitted, or an explicit null command. Encode that choice in the
  schema and in the executor.
- If `null` has the same meaning as omission for a tool field, the schema must
  explicitly allow `null` and the executor must normalize it before applying
  business logic.
- If `null` changes behavior, such as clearing an existing value, document that
  behavior in the field description and cover it at the tool boundary.
- Keep semantic contradictions in deterministic validation. For example, a
  nullable optional field may be valid for one mode and still rejected for a
  different mode that requires a real value.
- Prefer schema and executor alignment over prompt wording when a provider or
  model may serialize absent optional values differently.
- Author first-party model-facing tools through the local Zod tool helper for
  their runtime boundary: `zodTool(...)` for host-owned Junior tools and the
  plugin API's Zod helper for first-party plugin package tools. Do not add new
  raw object tool definitions for first-party tools.
- First-party tools should use structured Zod mode by default: declare an
  `outputSchema` extending the shared result object (`ok`, `status`, and common
  optional fields) instead of replacing it with a raw payload shape. Use
  tool-specific extensions for stable payload fields; a shared base schema is
  acceptable for transitional host tools and bridge/catalog tools whose payload
  shape is intentionally generic.
- Structured Zod tool executors return the schema-shaped details object
  directly. The helper and runtime adapters own the Pi-compatible
  model-visible content projection for those details.
- Use native content Zod mode only for multimodal/provider bridge tools where
  native model content is the contract, such as MCP image output. Native content
  tools do not declare a Junior `outputSchema` and return `{ content }` only;
  the runtime may synthesize generic base transcript details. Provider bridge
  layers own their own tracing/logging before adapting to this content-only
  result shape.
- Runtime adapters own provider-specific wrapping. Do not treat a remote
  provider schema such as an MCP `outputSchema` as the Junior Zod helper's
  structured result schema unless the Junior wrapper itself owns that result
  contract.
- Structured tools may declare `privateTraceResult` when part of their validated
  result is safe to retain in private traces. The projector must select only
  static, public, or otherwise non-conversation data. Omission keeps the default
  metadata-only behavior; returning `undefined` records no private result.
- Keep reusable tool infrastructure in a `tool-support` module or another
  non-`tools` module owned by that package. In the host runtime this is
  `packages/junior/src/chat/tool-support`; plugin packages should follow the
  same split locally. Files under any `tools` directory must be concrete tool
  definitions or tool executors, not shared helper modules.
- Keep runtime authority, destination, actor, credential, and durable context
  out of model-facing arguments unless the owning module explicitly allows them;
  see `policies/runtime-boundary-schemas.md`.
- Model-repairable execution failures must use the Pi tool-error channel so the
  agent receives a failed tool result and can correct its call. Throw
  `ToolInputError` or another expected tool error for invalid arguments,
  missing active context, unsupported values, or absent target state.
- Do not return sentinel success payloads such as `{ ok: false, error }` for a
  failed model-facing tool execution. Structured result unions remain valid in
  private helpers and non-agent HTTP handlers.

## Exceptions

- Omitted-only fields are acceptable when a present `null` would be ambiguous,
  unsafe, or meaningfully different from absence.
- Provider-owned MCP tools may expose provider schemas as-is. Junior-owned
  wrappers around those tools should still follow this policy.
