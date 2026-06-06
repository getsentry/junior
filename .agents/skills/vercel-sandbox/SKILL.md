---
name: vercel-sandbox
description: Investigate Vercel Sandbox lifecycle, timeout, snapshot, and persistence behavior. Use when users ask about Vercel Sandbox, `@vercel/sandbox`, `Sandbox.create`, `Sandbox.get`, why files disappeared, how snapshots differ from persistence, or whether Vercel's persistent sandbox beta applies.
---

Investigate Vercel Sandbox using current official docs, installed SDK contracts, and only then any consumer-specific integration code.

## Step 1: Classify the request

Pick the narrowest reference set before answering:

| Request type                                                                  | Read first                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------- |
| SDK/API behavior, lifecycle semantics, snapshots, stable vs beta persistence  | `references/api-surface.md`                 |
| Product-level usage patterns and architectural choices                        | `references/common-use-cases.md`            |
| Broken behavior, confusing docs, missing files, or suspected persistence bugs | `references/troubleshooting-workarounds.md` |

If the task spans categories, load only the relevant files above.

## Step 2: Establish which sandbox model applies

1. Inspect the installed `@vercel/sandbox` version and local types before trusting any doc page or changelog.
2. If local types only expose `sandboxId`, `Sandbox.get({ sandboxId })`, `extendTimeout`, and snapshot-backed `source`, treat the runtime as stable 1.x ephemeral sandboxes.
3. If local code and types expose named sandboxes, `name`, `persistent`, session updates, or automatic resume after stop, treat the runtime as the persistent beta model.
4. Qualify time-sensitive claims with a date or retrieval note.

## Step 3: Apply core guardrails

1. Distinguish three separate clocks before diagnosing workspace loss:
   - Vercel function/runtime timeout
   - Application/request timeout in the embedding system
   - Sandbox timeout
2. On stable 1.x, `Sandbox.get({ sandboxId })` only helps while the sandbox is still alive.
3. On stable 1.x, once the sandbox stops, its filesystem is gone. Do not describe that as resumable persistence.
4. `sandbox.snapshot()` is not workspace durability. It creates a new snapshot artifact and stops the source sandbox.
5. Snapshots and persistent beta solve different problems:
   - snapshots create new starting points
   - persistent beta preserves named workspace state across sessions
6. In embedded systems, inspect the consumer's persistence wiring before concluding that Vercel destroyed the workspace immediately.
7. Do not infer persistent-beta behavior from a changelog alone. Confirm the installed SDK and local call sites.

## Step 4: Investigate the Vercel surface first

1. Check the installed SDK surface first:
   - installed `@vercel/sandbox` types
   - official stable docs for concepts, snapshots, SDK reference, and limits
   - persistent-beta changelog only if named persistence is relevant
2. Determine whether the question is about:
   - active sandbox reuse
   - stopped sandbox recovery
   - snapshot-based warm starts
   - persistent named workspaces
3. Establish which timeout fired first and whether the sandbox should still have been active.

## Step 5: Inspect consumer code only when the task is app-specific

For repo-local debugging in Junior, inspect:

1. timeout budget alignment:
   - `packages/junior/src/chat/config.ts`
   - `packages/junior/src/chat/app/production.ts`
2. sandbox identity persistence and reuse:
   - `packages/junior/src/chat/runtime/thread-state.ts`
   - `packages/junior/src/chat/runtime/turn-preparation.ts`
   - `packages/junior/src/chat/sandbox/session.ts`
3. whether timeout paths actually resume:
   - `packages/junior/src/chat/respond.ts`
   - `packages/junior/src/chat/runtime/turn.ts`
4. whether sandbox metadata is only persisted on the success path:
   - `packages/junior/src/chat/runtime/reply-executor.ts`
5. whether consumer-specific snapshots are being confused with Vercel product persistence:
   - `specs/sandbox-snapshots-spec.md`

## Step 6: Recommend the smallest correct fix

Choose the narrowest fix that matches the diagnosed failure mode:

1. Sandbox still alive but next turn started fresh:
   - Persist sandbox identity earlier.
   - Resume from the active sandbox instead of recreating it.
2. Sandbox actually stopped:
   - Increase sandbox timeout or extend it while work is active.
   - Externalize intermediate outputs if they must survive stop.
3. Confusion caused by docs drift:
   - Align implementation advice to the installed SDK, not the newest beta docs.
4. Need true durability across stop/timeout boundaries:
   - Use external storage or migrate intentionally to the persistent beta model after confirming API availability.

## Step 7: Return a concrete diagnosis

Default report structure:

1. Active sandbox model: `stable-ephemeral` or `persistent-beta`
2. What likely timed out first
3. Whether the sandbox probably still existed after the failed turn
4. Whether workspace loss came from Vercel stop/destruction or consumer state handling
5. Smallest next fix, with the exact file(s) or SDK change required
