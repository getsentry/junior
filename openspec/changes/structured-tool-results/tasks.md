# Tasks

## 1. Result Contract Helper

- [x] Add a small internal helper that accepts a structured result object and
      returns Pi-compatible `{ content, details }`.
- [x] Define the common fields: `ok`, `status`, `target`, `data`,
      `truncated`, `continuation`, and `error`.
- [x] Render model-visible `content` from the same object stored in `details`.
- [x] Keep the rendered summary deterministic and compact.
- [x] Preserve native model content for multimodal provider bridge results
      instead of forcing those outputs through structured text.
- [x] Treat unexpected implementation failures as thrown errors, not encoded
      `ok=false` results.

## 2. Schema Surface

- [x] Extend the Zod tool-support path so a tool can declare and validate a
      structured result schema.
- [x] Define the host Zod tool modes: structured mode with `outputSchema`, and
      native content mode without tool-authored `details`.
- [x] Keep output validation failures classified as runtime contract failures,
      not model-repairable input failures.
- [x] Avoid requiring result schemas for tools that are not part of the first
      structured-result slice.
- [ ] Ensure deferred tool search can expose a concise result-shape summary only
      if it helps tool selection or follow-up.

## 3. First Tool Slice

- [x] Convert `readFile` to return structured target, range, truncation, and
      continuation data.
- [x] Convert `grep` and `listDir` to return structured target, match/item
      counts, truncation, and continuation data where available.
- [x] Convert `editFile` and `writeFile` to return structured target, changed
      state, and failure kind for expected edit misses.
- [x] Convert `bash` to return structured exit code, stdout/stderr truncation,
      timeout state, and error kind.
- [x] Convert `callMcpTool` to preserve upstream structured payloads while
      adding Junior-owned status and provider/tool identity.
- [x] Keep MCP image output in native model content instead of replacing it with
      only a structured summary.
- [x] Convert `sendMessage` to return structured channel/thread/message/file
      identifiers, permalink, and deduplication state.

## 4. Tests

- [x] Add focused tests for the result helper to prove `content` and `details`
      are derived from the same object.
- [x] Add integration-style tool tests for the converted file/search tools.
- [x] Add focused Slack side-effect coverage for the converted `sendMessage`
      result shape.
- [x] Add coverage that output schema failures are not reported as
      `ToolInputError`.
- [x] Avoid tests that assert logs, spans, or telemetry fields as behavior
      contracts.

## 5. Validation

- [x] Run targeted tests for changed tool families.
- [x] Run `pnpm typecheck`.
- [x] Run local-agent validation for at least one workflow that requires reading
      a truncated file or following a continuation.
- [x] Update the owning module docs if the public tool behavior changes.
