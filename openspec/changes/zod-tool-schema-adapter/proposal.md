# Zod Tool Schema Adapter

## Summary

Add a schema adapter layer for Junior-owned agent tools so tools can be authored
with Zod parsers while Pi continues to receive JSON Schema-compatible tool
parameters.

## Motivation

Junior-owned tools currently use TypeBox schemas primarily because Pi's public
tool types are TypeBox-shaped. Pi's runtime already accepts plain JSON Schema
for provider payloads and validation fallback, and Zod gives Junior a stronger
parser boundary for model-produced arguments. A Zod adapter lets tool executors
receive parsed inputs, turns parser failures into model-visible tool errors, and
keeps the Pi compatibility cast isolated at the adapter boundary.

## Scope

- Introduce an internal `zodTool(...)` wrapper for Junior-owned tools.
- Introduce a public `definePluginTool(...)` helper for plugin-authored tools.
- Represent model-facing tool parameters as JSON Schema-compatible schemas in
  Junior's erased tool registry.
- Convert Zod tool input schemas to JSON Schema before handing them to Pi.
- Parse model arguments with Zod before executor code runs.
- Convert Zod parse failures into the appropriate tool input error type so Pi
  records an `isError=true` tool result that the agent can repair.
- Optionally validate tool outputs with Zod as developer/runtime contract
  failures, not model-input failures.
- Migrate Junior-owned internal tools to the wrapper in this change.

## Non-Goals

- Converting provider-owned MCP schemas.
- Converting plugin tools that do not opt in to the plugin API helper.
- Synthesizing real TypeBox schemas from Zod-generated JSON Schema.
- Changing Pi package source or vendoring Pi types.

## Compatibility

Existing TypeBox-authored tools remain valid during the migration. The final
internal tool registry should expose JSON Schema-compatible parameters to Pi and
keep any TypeBox-only casts localized to Pi adapter code.
