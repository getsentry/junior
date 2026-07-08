# Deferred Tool Discovery

## Summary

Make deferred catalog tools discoverable by source so the model can find plugin
and future provider tools without those tools being directly registered as
native model tools.

## Motivation

Memory workflow eval failures in #784 point at a discoverability gap: memory
tools exist as deferred plugin tools, but the model must already know to call
`searchTools` and then `executeTool`. The current direct tool description says
there is an executable catalog, but it does not advertise that deferred tools
exist or which sources can be searched.

Codex has useful prior art here: its tool search surface tells the model that
tools are available from known sources and that some tools may need discovery.
Junior should adopt the source-advertising pattern while keeping its current
`executeTool` bridge because Junior does not yet load discovered tools into the
next model turn.

## Scope

- Add `source` as the model-facing grouping concept for deferred catalog tools.
- Advertise available deferred sources in the `searchTools` description.
- Add an optional `source` filter to `searchTools`.
- Return compact source summaries and compact per-tool metadata from search.
- Auto-summarize model-visible tool and source descriptions.
- Carry source metadata from plugin tool registration into the executable
  catalog.
- Leave `executeTool` as the current execution bridge.
- Align the shape with a future where MCP provider tools can share the same
  catalog through sources such as `mcp:sentry`.

## Non-Goals

- Direct-registering every plugin or MCP tool as a native model tool.
- Implementing Codex-style deferred tool loading into the next model turn.
- Replacing existing MCP activation rules in this change.
- Defining provider-specific workflows or memory storage semantics.
- Emitting full plugin or MCP provider metadata in every search result.

## Design Notes

`source` should be the single public grouping term. Avoid introducing separate
model-facing names such as namespace, domain, or owner for the same concept.

`searchTools` should accept:

```ts
{
  query?: string | null;
  source?: string | null;
  max_results?: number | null;
}
```

The native `searchTools` description should list known deferred sources, not all
known tools:

```text
Deferred tools are grouped by source. Use searchTools with source to inspect one
source, then executeTool with the exact returned tool_name.

Available sources:
- memory: Long-term memory storage, recall, listing, and removal.
```

Search results should include source summaries once at the top level. When a
search is filtered to one source, per-tool results should omit `source`. When a
search spans sources, per-tool results may include only the compact source id.

Descriptions shown to the model should be summarized by normalizing whitespace,
using the first meaningful line or paragraph before a blank break, and applying
a hard cap around 160-200 characters. Full descriptions may still be used for
search indexing.

## Compatibility

Existing direct tools remain direct. Existing deferred tools remain executable
through `executeTool`. Models that already know an exact catalog `tool_name` may
still call `executeTool` directly, but the intended model path is discovery via
`searchTools` when the exact name is unknown.

Dedicated MCP search/execution paths may remain while MCP activation is
separate. Future MCP unification should map providers into the same `source`
contract instead of inventing a second grouping field.

## Risks

- Source descriptions could become another prompt-bloat surface if not
  truncated.
- Empty-query discovery could dump too much of the catalog unless explicitly
  bounded.
- If source metadata is only inferred from plugin names, source descriptions may
  be weak until plugin registration carries concise descriptions.
