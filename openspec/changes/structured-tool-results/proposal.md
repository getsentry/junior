# Structured Tool Results

## Summary

Add a Junior-owned structured result contract for high-leverage agent tools so
tool outcomes are explicit, validated, and reliably usable by the model for
follow-up work.

## Motivation

Pi already provides a generic `AgentToolResult<TDetails>` envelope with
model-visible `content` and structured `details`. That envelope is useful, but
it does not define Junior's domain contract for tool outcomes, and Pi provider
adapters send the model `content`, not `details`.

Junior currently returns a mix of plain values, ad hoc objects, and structured
`{ content, details }` results. Some tools expose useful fields such as
truncation, target paths, Slack timestamps, or deduplication state, but the
shape is not consistently declared or rendered into a model-visible result. This
makes continuation behavior depend on prose conventions and model inference.

## Scope

- Introduce a Junior-owned structured tool result envelope for internal tools.
- Keep Pi's `AgentToolResult` as the transport boundary; do not change Pi.
- Render a compact deterministic text summary into model-visible `content`.
- Preserve the same structured object in `details` for UI, reporting, logging,
  and tests when a Junior structured result schema owns the output.
- Preserve native model content for multimodal/provider bridge results when a
  structured text projection would hide the provider payload, such as MCP image
  output.
- Support per-tool result schemas through the existing Zod tool-support layer or
  a small adjacent helper.
- Convert only high-leverage tools in the first implementation slice:
  - `bash`
  - `readFile`
  - `grep`
  - `listDir`
  - `editFile`
  - `writeFile`
  - `callMcpTool`
  - Slack side-effect tools, starting with `sendMessage`
- Include structured continuation data for partial or paginated results.
- Include structured error data for expected operational failures that the model
  can repair or route around.

## Non-Goals

- Replacing Pi's tool execution envelope.
- Changing provider-owned MCP result schemas.
- Converting every tool in one change.
- Treating remote provider schemas, such as MCP `outputSchema`, as Junior-owned
  structured result schemas.
- Adding verbose generic metadata to small tools whose result is already
  unambiguous.
- Encoding business-specific retry policy inside every result.
- Using structured result fields as a substitute for throwing unexpected runtime
  failures.

## Design Notes

The common result shape should be small and stable:

```ts
type JuniorToolResult<TData = unknown> = {
  ok: boolean;
  status: "success" | "error";
  target?: string;
  data?: TData;
  truncated?: boolean;
  continuation?: {
    tool_name: string;
    arguments: Record<string, unknown>;
    reason?: string;
  };
  error?: {
    kind: string;
    message: string;
    retryable?: boolean;
  };
};
```

Tool-specific data belongs under `data` or a typed equivalent when that is more
ergonomic. The helper should produce a Pi-compatible result:

```ts
{
  content: [{ type: "text", text: stableJsonSummary }],
  details: structuredResult
}
```

Host-owned `zodTool(...)` has two result modes. Structured mode declares a
Junior `outputSchema`, validates the returned details object, and lets the
runtime produce the model-visible projection from those details. Native content
mode is reserved for multimodal/provider bridge output; it omits a Junior
`outputSchema` and returns `{ content }` only, with generic base details
synthesized at the adapter boundary. Native bridge layers own provider-specific
tracing/logging before adapting their output to this content-only result shape.

The model-visible text should be compact JSON or another deterministic
machine-readable projection. It should include the fields needed to decide
whether work is complete, whether more data is available, and what exact tool
call continues the result.

## Compatibility

Existing non-Zod tools may continue returning plain values during migration.
First-party Zod-authored tools should use structured mode by default. Native
content mode is an explicit exception for provider or multimodal bridges, not a
general replacement for structured result schemas.

## Risks

- Over-standardizing low-value tools could add noise without improving model
  behavior.
- If `details` and `content` diverge, the UI/logging view and model view can
  disagree. The helper should derive both from the same object.
- Tool-specific result schemas could become too broad. Prefer small schemas
  driven by actual continuation and auditing needs.
