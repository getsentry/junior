## Why

Junior uses OpenTelemetry semantic attributes across logs and spans, plus repo-specific `app.*` fallbacks. The existing `specs/otel-semantics.md` is the canonical map, but it is not expressed as OpenSpec requirements. Backfilling it prevents drift in key naming, legacy aliases, GenAI usage keys, MCP attributes, and custom `app.*` namespaces.

## What Changes

- Add an `otel-semantics` OpenSpec capability baseline.
- Specify semantic-first key selection, custom fallback rules, core context keys, GenAI/MCP/process/error keys, legacy normalization, and governance for new attributes.
- Record current local attribute inventory, prior art, open questions, and verification coverage.
- Do not change logging or tracing code.

## Capabilities

### New Capabilities

- `otel-semantics`: Defines Junior's OpenTelemetry semantic attribute map and custom `app.*` fallback policy.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec artifacts under `openspec/changes/backfill-otel-semantics/`.
- Completes the Tier 6 observability/security backfill set.
