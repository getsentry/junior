# Runtime Boundary Schemas

## Intent

Runtime boundary contracts should not depend on TypeScript trust alone. When data crosses an external, async, durable, or plugin boundary, Junior needs one runtime schema that also owns the exported TypeScript type so parsing behavior and compile-time contracts cannot drift.

## Policy

- Shared contracts that cross plugin, scheduler, dispatch, queue, callback, sandbox, API, or durable-state boundaries must have an owning runtime schema.
- Exported TypeScript types for those contracts must be inferred from the owning schema, normally with `z.output<typeof schema>` or the repo-standard equivalent.
- Public plugin API contracts live in `@sentry/junior-plugin-api`; feature-internal durable records may keep local schemas in the feature module.
- Boundary parsers accept `unknown` and return parsed output types. Downstream runtime code should receive parsed types, not re-check ad hoc object shapes.
- Schemas are strict by default. Unknown fields are rejected unless the field is explicitly documented as an opaque extension payload.
- Required actor, destination, credential-subject, and routing fields must not use defaults, fallbacks, or nearby metadata repair.
- Normalization is allowed only at platform ingress or explicit constructor helpers that convert external platform payloads into canonical Junior values. Durable-state and plugin-input parsers must assert canonical shape without repair.
- Runtime-owned bindings, signatures, actor identity, destination identity, and credential subjects must be parsed as separate fields. Do not infer one from another after crossing a boundary.
- Tool input JSON schemas may stay on the tool/schema system that serves the model. If a tool input carries runtime authority or durable context, that context must also be validated by the owning runtime boundary schema.
- Model-facing tool schema design rules live in `policies/tool-design.md`.

## Exceptions

- One-time migrations may repair legacy malformed state, but the migration must be named, bounded, and verified separately from normal runtime reads.
- Opaque provider payloads may be preserved with permissive schemas only when they are not used for routing, authorization, credentials, locks, or side effects.
