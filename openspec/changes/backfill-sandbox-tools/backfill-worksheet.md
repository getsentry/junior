# Backfill Worksheet: `sandbox-tools`

## Scope

- Capability: Sandbox tools
- Change: `backfill-sandbox-tools`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/sandbox-tools/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/tool-execution.md`: shared Pi tool wrapper, result normalization, expected tool errors, auth interrupts, and idempotency.
- `specs/security-policy.md`: sandbox isolation, host filesystem and credential handling constraints.
- `specs/credential-injection.md`: requester-bound credential injection into sandbox commands.
- `specs/sandbox-snapshots.md`: dependency snapshot warm-start behavior.
- `specs/slack-agent-delivery.md`: file delivery in final Slack replies.
- `specs/reply-planning.md`: reply-file planning and file visibility.
- `specs/testing.md`: test layer boundaries.

### Code Paths

- `packages/junior/src/chat/sandbox/session.ts`: sandbox create/get, named non-persistent sessions, snapshot-backed creation, keepalive, skill/reference sync, and tool executor setup.
- `packages/junior/src/chat/sandbox/sandbox.ts`: sandbox executor and shell/file command adaptation.
- `packages/junior/src/chat/sandbox/workspace.ts`: workspace abstraction used by tools.
- `packages/junior/src/chat/tools/sandbox/bash.ts`: bash tool definition.
- `packages/junior/src/chat/tools/sandbox/read-file.ts`: bounded line-window reads.
- `packages/junior/src/chat/tools/sandbox/list-dir.ts`: bounded directory listing.
- `packages/junior/src/chat/tools/sandbox/find-files.ts`: glob file discovery.
- `packages/junior/src/chat/tools/sandbox/grep.ts`: bounded content search.
- `packages/junior/src/chat/tools/sandbox/edit-file.ts` and `text-edits.ts`: exact text replacement validation and diff output.
- `packages/junior/src/chat/tools/sandbox/write-file.ts`: full-file write definition.
- `packages/junior/src/chat/tools/sandbox/attach-file.ts`: sandbox/generated-file attachment handoff.
- `packages/junior/src/chat/tools/execution/build-sandbox-input.ts`: input normalization before sandbox execution.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/tools/sandbox/file-tools.test.ts`
  - `packages/junior/tests/unit/misc/attach-file.test.ts`
  - `packages/junior/tests/unit/misc/bash-tool-sandbox-adapter.test.ts`
  - `packages/junior/tests/unit/misc/sandbox-executor.test.ts`
  - `packages/junior/tests/unit/runtime/respond-lazy-sandbox.test.ts`
  - `packages/junior/tests/unit/tools/execution/build-sandbox-input.test.ts`
  - `packages/junior/tests/unit/sandbox/resolve-host-data-path.test.ts`
  - `packages/junior/tests/unit/skills/skill-sandbox.test.ts`
- Integration:
  - `packages/junior/tests/integration/sandbox-egress-proxy.test.ts`
  - Tool-family integration/eval cases that rely on sandbox command execution.
- Evals:
  - Model behavior for choosing correct sandbox tools belongs to agent/tool-family evals, not the deterministic tool contracts here.

## Prior Art

- Vercel Sandbox skill references distinguish active sandbox reuse, timeout extension, snapshot-backed fresh starts, and persistent named workspace recovery.
- Local package state uses `@vercel/sandbox` `2.0.0`.
- Current Junior session code explicitly passes `persistent: false` for named sandbox creation in inspected paths, so the baseline contract should not imply persistent workspace recovery after stop.
- Runtime dependency snapshots are warm-start artifacts; they are not durable snapshots of user task workspaces.

## Implemented Behavior

- Behavior that code currently enforces:
  - Sandbox tools are registered as normal tools but host `execute` methods fail without sandbox execution.
  - The wrapper routes sandbox-owned tools to the sandbox executor.
  - Relative structured file paths resolve under `/vercel/sandbox`; out-of-workspace structured file paths throw `ToolInputError`.
  - File reads are bounded by line ranges and include continuation guidance.
  - List/find/grep traversal skips `.git` and `node_modules`, sorts output, and bounds result/character/line output.
  - Missing list/find/grep paths return model-visible not-found results.
  - `grep` invalid regex throws `ToolInputError`.
  - `editFile` applies exact replacements, rejects ambiguous/missing/overlapping edits, preserves line endings/BOM, and returns a compact diff.
  - `writeFile` is sequential and intended for new/full replacements.
  - `attachFile` reads sandbox files, falls back to same-turn generated files by basename, enforces non-empty and 10 MiB limit, and emits `FileUpload` through hooks.
  - MIME detection uses sandbox `file --mime-type` when available, otherwise extension fallback.
  - Sandbox session manager can use snapshot-backed sandbox creation and active sandbox timeout extension.
- Behavior that tests currently verify:
  - Bounded reads, exact edits, edit argument preparation, list/find/grep traversal, globstar matching, missing paths, disappearing files, and grep context dedupe.
  - Attach-file success, missing file, same-turn generated file fallback, oversized file failure, and MIME fallback.
  - Vercel Sandbox v2 adapter shape for read/write/file tools.
  - Lazy sandbox acquisition and attachment behavior across failure/recovery paths.
  - Sandbox executor snapshot and egress behavior in focused tests.
- Behavior that appears accidental or weakly enforced:
  - `attachFile` missing/empty/oversized failures are model-repairable but currently generic rather than `ToolInputError`.
  - Command interruption and timeout behavior is not clearly specified in this capability.
  - `/tmp` paths for generated artifacts are intentionally accepted by `attachFile`, but the boundary is not documented.
  - Missing-path behavior differs between search/list and edit/read surfaces.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Sandbox tools run in isolated sandbox, never on the host.
  - Structured filesystem tools are scoped to workspace root.
  - Outputs are bounded and include truncation/continuation notices.
  - Exact edits are validated before mutation.
  - Generated files can be attached to replies through hooks.
  - Active sandbox reuse and timeout extension are allowed, but stopped workspace persistence is not assumed.
- Behavior that should remain implementation detail:
  - Exact traversal limits and line/character budgets unless product fixes them.
  - Exact sandbox SDK parameter object shape.
  - Exact command used for MIME detection.
  - Exact diff format details beyond compact changed-line evidence.
- Behavior that should be non-goal:
  - Generic tool wrapper semantics.
  - Provider credential lease/injection policy.
  - Slack file upload API mechanics.
  - Durable workspace persistence after sandbox stop.

## Undefined Behavior / Open Questions

| Question                                                       | Evidence                                                                                   | Options                                                                                                     | Recommendation                                                                                                        | Status |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| Which missing-path results are failures versus discovery data? | Search/list return `ok:false`; edit throws `ToolInputError`; attach throws generic errors. | Convert repairable failures, keep specified discovery no-results as data, or standardize all missing paths. | Keep discovery no-results only when documented; convert invalid/mutating/attachment failures to expected tool errors. | open   |
| Should attach-file errors be expected tool-input errors?       | Missing/empty/oversized are model-repairable.                                              | Convert to `ToolInputError`, introduce family-specific expected error, or keep generic.                     | Convert to `ToolInputError` unless implementation audit finds a non-repairable system failure.                        | open   |
| Where is bash interruption canonical?                          | Bash/executor tests exist; details spread through executor/session.                        | Sandbox-tools, sandbox executor, or tool-execution.                                                         | Own user-visible bash result shape here; executor lifecycle in session spec if split later.                           | open   |
| Is `/tmp` attachment path support intentional?                 | `attachFile` allows absolute paths and describes `/tmp/screenshot.png`.                    | Keep, restrict to workspace, or whitelist generated dirs.                                                   | Keep as explicit generated-artifact exception.                                                                        | open   |
| Should v2 persistent sandbox behavior be adopted?              | Local create uses `persistent:false`; skill warns not to infer persistence.                | Current non-persistent, migrate to persistent, or hybrid.                                                   | Current spec: non-persistent baseline. Future migration needs spec change.                                            | open   |

## OpenSpec Requirements Draft

| Requirement                 | Scenarios                                              | Source Evidence                          | Notes                                      |
| --------------------------- | ------------------------------------------------------ | ---------------------------------------- | ------------------------------------------ |
| Sandbox lifecycle for tools | active reuse, create/get, snapshot, keepalive, stopped | session/sandbox code, Vercel skill refs  | No stopped persistence promise.            |
| Sandbox executor routing    | host fail, wrapper route, normalize                    | tool definitions, wrapper, adapter tests | Shared wrapper cross-link.                 |
| Workspace path confinement  | relative, absolute, outside, attach exception          | file-utils, attach-file                  | Security-sensitive.                        |
| Bounded file reading        | no range, range, continuation, missing                 | read-file, tests                         | Missing behavior may be executor-specific. |
| Bounded workspace discovery | list, find, grep, truncation, missing                  | list/find/grep, tests                    | Structured over shell.                     |
| Exact edit behavior         | unique, ambiguous, missing, multiple                   | edit-file/text-edits, tests              | Model-repairable.                          |
| Full-file write behavior    | new write, prefer edit                                 | write-file                               | Prompt/tool guidance.                      |
| Bash command behavior       | sandbox, timeout, interrupted/large                    | bash, executor/session tests             | Needs gap review.                          |
| Sandbox file attachment     | file, generated cache, MIME, errors                    | attach-file, tests                       | Slack upload elsewhere.                    |
| Verification taxonomy       | unit, mocked SDK, live sandbox                         | testing spec                             | Network may need escalation.               |

## Migration Notes

- Canonical spec updates:
  - Add `sandbox-tools` to index after acceptance.
  - Keep dependency snapshot behavior in `sandbox-snapshots`.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Avoid duplicating sandbox tool rules in `agent-execution` or `tool-execution`.
- Test/eval taxonomy changes:
  - Move model-choice evals out of deterministic sandbox tool spec.
  - Keep live Vercel sandbox checks opt-in when network/credentials are required.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-sandbox-tools' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: attach-file expected error shape, bash interruption semantics, `/tmp` path policy, and stopped-workspace persistence decision.
