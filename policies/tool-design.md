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
- Keep runtime authority, destination, actor, credential, and durable context
  out of model-facing arguments unless the owning spec explicitly allows them;
  see `policies/runtime-boundary-schemas.md`.

## Exceptions

- Omitted-only fields are acceptable when a present `null` would be ambiguous,
  unsafe, or meaningfully different from absence.
- Provider-owned MCP tools may expose provider schemas as-is. Junior-owned
  wrappers around those tools should still follow this policy.
