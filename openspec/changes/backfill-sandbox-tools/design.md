# Design: `sandbox-tools`

## Scope

`sandbox-tools` owns the concrete agent tools that inspect or mutate the sandbox workspace and attach sandbox files to the final reply. It also records the sandbox lifecycle assumptions that those tools rely on.

It does not own generic Pi tool wrapping, provider credential policy, plugin runtime dependency snapshot building, or Slack API upload mechanics.

## Vercel Sandbox Model

Local evidence:

- `packages/junior/package.json` declares `@vercel/sandbox` `2.0.0`.
- Current session code uses named `Sandbox.create`/`Sandbox.get`, explicit `persistent: false`, active sandbox reuse, timeout extension, and snapshot-backed fresh creation for dependency profiles.
- Runtime dependency snapshots are used for warm starts, not as durable per-user workspace persistence.

The spec should therefore not promise recovery of stopped sandbox workspace state. If Junior later opts into a persistent sandbox model, that is a separate behavior change requiring spec updates.

## Design Decisions

### Sandbox-backed tools fail without sandbox execution

Core sandbox tool definitions are present, but their host `execute` implementations intentionally fail when the sandbox executor is absent. The shared tool wrapper decides whether a tool name is sandbox-owned and routes execution through the sandbox executor.

### Workspace tools stay inside the workspace root

File discovery, reading, and editing tools operate under `/vercel/sandbox`. Paths outside the workspace are model-input errors, not host filesystem access.

### Prefer structured filesystem tools over shell for inspection/editing

`readFile`, `listDir`, `findFiles`, `grep`, `editFile`, and `writeFile` are bounded and structured. `bash` remains available for execution tasks, but routine inspection/editing should use structured tools where possible.

### Exact edits are safer than full-file writes

`editFile` requires exact, unique, non-overlapping replacements and returns a compact diff. Full-file writes are still available for new files or deliberate replacements, but targeted existing-file edits should use exact edits.

### Attachment handoff is a tool-to-reply bridge

`attachFile` reads a sandbox file or same-turn generated file and emits a `FileUpload` through tool hooks. Slack upload and final visibility are owned by reply planning/outbound delivery.

## Risks

- Path confinement is only as strong as every sandbox file helper using shared path resolution.
- Some discovery-style missing-path paths return successful structured `ok:false` search results. That can be valid only when the tool spec treats the absence as negative domain data; repairable invalid paths, unsupported state, and attachment failures should follow the shared expected-tool-error policy.
- Stable/persistent sandbox API drift could invalidate lifecycle assumptions.
- Command interruption/timeout behavior may be more strongly defined in the sandbox executor than in individual tool specs.

## Open Questions

1. Which sandbox missing-path results are successful negative discovery data, and which are repairable input/context failures that must become `ToolInputError`?
2. Should `attachFile` missing/empty/oversized file failures become `ToolInputError` rather than generic errors?
3. Should bash command timeout/interruption semantics be specified here or in the sandbox executor/session layer?
4. Should sandbox path confinement apply to `attachFile` absolute `/tmp` paths, or is `/tmp` intentionally allowed for generated browser/screenshot artifacts?
