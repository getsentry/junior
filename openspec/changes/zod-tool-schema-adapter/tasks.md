# Tasks

## 1. Tool Schema Adapter

- [x] Add a JSON Schema-compatible internal tool schema type.
- [x] Add `zodTool(...)` in the internal tool-support layer.
- [x] Convert Zod schemas to model-facing JSON Schema in the helper.
- [x] Parse `prepareArguments` with Zod and convert `ZodError` to
      `ToolInputError` with concise model-actionable messages.
- [x] Support optional output schema validation as a runtime contract failure.
- [x] Keep Pi `TSchema` casts isolated in `createAgentTools(...)` or the
      smallest Pi adapter boundary.
- [x] Add a public plugin helper that converts Zod parse failures into
      `PluginToolInputError`.

## 2. Internal Tool Migration

- [x] Migrate Junior-owned non-plugin tools from TypeBox `tool(...)` to
      `zodTool(...)`.
- [x] Preserve field descriptions, nullability, defaults, and executor
      semantics.
- [x] Leave provider-owned MCP schemas and non-helper plugin-owned schemas
      unchanged.
- [x] Remove internal TypeBox dependencies only when no remaining owned tool or
      runtime path needs them.

## 3. Tests

- [x] Cover valid Zod argument parsing and executor input typing.
- [x] Cover invalid Zod arguments becoming Pi-compatible `isError=true` tool
      results.
- [x] Cover model-facing JSON Schema shape for at least one converted tool.
- [x] Cover output schema validation behavior if output validation is included.
- [x] Run focused tests for converted tool families.

## 4. Verification

- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] Focused tool tests
- [x] Any package builds affected by public or publishable surfaces
