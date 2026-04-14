# Vercel Sandbox API Surface

Use this reference when the question is primarily about Vercel Sandbox lifecycle semantics, timeout behavior, snapshots, or whether a specific SDK feature exists in the current environment.

## Official docs to anchor on first

| Topic                            | Source                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Product overview, auth, runtimes | `https://vercel.com/docs/vercel-sandbox/`                                                                        |
| Stable lifecycle semantics       | `https://vercel.com/docs/vercel-sandbox/concepts`                                                                |
| Stable snapshot semantics        | `https://vercel.com/docs/vercel-sandbox/concepts/snapshots`                                                      |
| Stable SDK methods               | `https://vercel.com/docs/vercel-sandbox/sdk-reference`                                                           |
| Timeouts and limits              | `https://vercel.com/docs/vercel-sandbox/working-with-sandbox`, `https://vercel.com/docs/vercel-sandbox/pricing/` |
| Persistent beta semantics        | `https://vercel.com/changelog/vercel-sandbox-persistent-sandboxes-beta`                                          |

## Model split to establish first

| Concern                     | Stable 1.x model                                                              | Persistent beta model                                    | What to verify locally                                        |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Identity                    | `sandboxId`                                                                   | stable `name`, plus session/snapshot management          | Inspect installed `sandbox.d.ts` before assuming either model |
| Reattach while active       | `Sandbox.get({ sandboxId })`                                                  | resume by `name`, plus explicit session management APIs  | Check local call sites and types                              |
| Behavior after stop/timeout | Filesystem destroyed when sandbox stops                                       | Automatic snapshot on stop/timeout, later resume by name | Confirm repo actually uses beta APIs before relying on this   |
| Create params               | `timeout`, `runtime`, `networkPolicy`, `env`, `source` with snapshot          | beta adds persistence-oriented fields such as `name`     | Installed types are the source of truth                       |
| Snapshot behavior           | `sandbox.snapshot()` creates a reusable snapshot and stops the source sandbox | still separate from named persistence                    | Do not conflate snapshots with live workspace continuity      |
| Timeout extension           | `sandbox.extendTimeout(ms)` while active                                      | still relevant, but durability model is different        | Confirm whether code extends timeout today                    |

## Stable 1.x behavior to assume unless proven otherwise

1. Sandboxes are ephemeral Linux VMs.
2. `Sandbox.get({ sandboxId })` is for reconnecting to an existing active sandbox, not resurrecting a stopped one.
3. Timeout defaults are short unless the creator sets a longer sandbox timeout.
4. `extendTimeout()` only extends the life of an already-running sandbox.
5. `snapshot()` captures a new snapshot artifact and stops the source sandbox.
6. Snapshot-created sandboxes are new sandboxes created from a saved starting point, not resumed sessions of the original sandbox.

## Persistent beta behavior to treat as opt-in

Persistent beta materially changes the recovery model:

1. Sandboxes are identified by name.
2. Stop/timeout automatically snapshots the filesystem.
3. A later `get` by name resumes from the last snapshot instead of starting clean.
4. Docs and examples that mention `name`, `persistent`, session updates, or explicit session deletion are describing this newer model.

Do not recommend this path unless the repo has upgraded to the beta SDK and local types support the required calls.

## Snapshot semantics that matter in both models

1. Snapshots are explicit saved filesystem states.
2. In stable 1.x, snapshotting stops the source sandbox and leaves you with a `snapshotId`.
3. Creating from a snapshot gives you a fresh sandbox whose initial filesystem matches the snapshot.
4. Snapshots are useful for dependency warmup, checkpointing, and reproducible starting points.
5. Snapshots are not a substitute for active-session reattach.

## Consumer integration example in this repo

This section is secondary. Use it only when the task is about Junior's Vercel Sandbox integration rather than Vercel Sandbox itself.

| File                                                   | Why it matters                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `packages/junior/package.json`                         | Declares the `@vercel/sandbox` dependency used by the repo                             |
| `packages/junior/src/chat/sandbox/session.ts`          | Main sandbox create/get/reuse/keepalive logic                                          |
| `packages/junior/src/chat/runtime/thread-state.ts`     | Persists `app_sandbox_id` and dependency profile hash into thread state                |
| `packages/junior/src/chat/runtime/turn-preparation.ts` | Restores persisted sandbox metadata at the start of a turn                             |
| `packages/junior/src/chat/runtime/reply-executor.ts`   | Persists sandbox metadata only on the success path                                     |
| `packages/junior/src/chat/respond.ts`                  | Handles timeout and auth-pause behavior, returns sandbox metadata from a finished turn |
| `packages/junior/src/chat/app/production.ts`           | States that timeout checkpoints are not currently resumed in production                |
| `specs/sandbox-snapshots-spec.md`                      | Explains that snapshots are used for runtime dependency warmup, not task workspaces    |

## Local implementation facts worth checking in any consumer

1. Whether the installed SDK surface matches the doc page being cited.
2. Whether the embedding system's timeout is shorter than the sandbox timeout.
3. Whether active sandbox identity is persisted before the embedding system can fail.
4. Whether a recreated sandbox came from true loss or from consumer-side invalidation logic.

## Investigation checklist

1. Inspect installed SDK types first.
2. Determine whether the failure happened while the sandbox was still active or after it stopped.
3. Inspect consumer persistence logic only after the platform model is clear.
4. Check whether timeout resume is implemented locally or only specified.
5. Recommend fixes against the active model only.
