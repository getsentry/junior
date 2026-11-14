# Runtime Boundary Schemas

## Intent

Runtime edge contracts must not depend on TypeScript trust alone. When data
crosses an external, async, durable, or plugin edge, Junior needs one runtime
schema that also owns the exported TypeScript type. Parsing behavior and
compile-time contracts must not drift.

## Policy

- Shared contracts that cross plugin, scheduler, dispatch, queue, callback,
  sandbox, API, or durable-state edges must have an owning runtime schema.
- Exported TypeScript types for those contracts must come from the owning
  schema, normally with `z.output<typeof schema>` or the repo-standard
  equivalent.
- Public plugin API contracts live in `@sentry/junior-plugin-api`. Feature-local
  durable records may keep local schemas in the feature module.
- Edge parsers accept `unknown` and return parsed output types. Later runtime
  code should receive parsed types. It should not re-check ad hoc object shapes.
- Schemas are strict by default. Unknown fields are rejected unless the field is
  explicitly documented as an opaque extension payload.
- Required actor, destination, credential-subject, and routing fields must not
  use defaults, fallbacks, or nearby metadata repair.
- Normalization is allowed only at platform ingress or explicit constructor
  helpers that convert external platform payloads into canonical Junior values.
  Durable-state and plugin-input parsers must assert canonical shape without
  repair.
- Runtime-owned bindings, signatures, actor identity, destination identity, and
  credential subjects must be parsed as separate fields. Do not infer one from
  another after crossing an edge.
- Tool input JSON schemas may stay on the tool or schema system that serves the
  model. If a tool input carries runtime authority or durable context, that
  context must also pass the owning runtime edge schema.
- Model-facing tool schema design rules live in `policies/tool-design.md`.

## Exceptions

- One-time migrations may repair legacy malformed state. The migration must be
  named, bounded, and verified separately from normal runtime reads.
- Opaque provider payloads may use permissive schemas only when they are not
  used for routing, authorization, credentials, locks, or side effects.
