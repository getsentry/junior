# Common Use Cases

Use this reference when the question is about how to apply Vercel Sandbox to a real problem or architecture.

## 1. Run a long build or test job in a single sandbox

| First checks                                                                                                                             | Local files                                                   | Likely conclusion                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| How long does the job actually run? Is the default sandbox timeout sufficient? Do you need more than one request to drive the same work? | Stable timeout docs, pricing/limits docs, installed SDK types | Increase sandbox timeout up front and use `extendTimeout()` for truly long active sessions |

## 2. Reattach to a still-running sandbox from another request or worker

| First checks                                                 | Local files                               | Likely conclusion                                                                       |
| ------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Was there a valid `sandboxId`? Was the sandbox still active? | Installed `sandbox.d.ts`, stable SDK docs | On stable 1.x, `Sandbox.get({ sandboxId })` is the right active-session reuse mechanism |

## 3. Create faster warm starts with snapshots

| First checks                                                             | Local files                             | Likely conclusion                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Is the expensive part deterministic setup rather than unique user state? | Snapshot docs, installed `sandbox.d.ts` | Snapshot after setup, then create future sandboxes from `snapshotId` instead of reinstalling dependencies every time |

## 4. Decide whether snapshots or persistent beta solve the real durability need

| First checks                                                                                        | Local files                                                   | Likely conclusion                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Do you need a reusable starting point, or the same named workspace to come back after stop/timeout? | Snapshot docs, persistent-beta changelog, installed SDK types | Use snapshots for reusable starting points; use persistent beta only when you need named workspace continuity |

## 5. Explain why files disappeared after timeout or stop

| First checks                                                                                                          | Local files                                               | Likely conclusion                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Was the sandbox still active, or did it actually stop? Was the environment using stable or persistent-beta semantics? | Concepts docs, stable SDK docs, persistent-beta changelog | On stable 1.x, stopped means destroyed filesystem. On persistent beta, stop/timeout can be resumable by name |

## 6. Embed Vercel Sandbox inside a serverless application

| First checks                                                                                                                              | Local files                                  | Likely conclusion                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Is the application request timeout shorter than the sandbox timeout? Does the app persist sandbox identity separately from sandbox state? | Consumer runtime config, installed SDK types | The app can fail before the sandbox does. Active-sandbox reuse requires consumer-managed identity persistence |

## 7. Preserve outputs even if the sandbox is ephemeral

| First checks                                                                               | Local files                                   | Likely conclusion                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Does the user need the full workspace, or only artifacts, logs, diffs, or generated files? | Product requirements, attachment/export paths | Externalizing artifacts is often cheaper and safer than preserving the entire sandbox filesystem |

## 8. Migrate documentation or code from stable 1.x assumptions to persistent beta

| First checks                                                                                                      | Local files                                       | Likely conclusion                                               |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| Does the local SDK actually expose beta persistence APIs? Are existing assumptions built around `sandboxId` only? | Installed types, local call sites, beta changelog | Named persistence is a real API migration, not just a doc tweak |

## 9. Investigate a consumer-specific reuse bug in this repo

| First checks                                                                        | Local files                                                                                                                                                      | Likely conclusion                                                                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Did the consumer persist sandbox identity? Did it only persist on the success path? | `packages/junior/src/chat/runtime/reply-executor.ts`, `packages/junior/src/chat/runtime/thread-state.ts`, `packages/junior/src/chat/runtime/turn-preparation.ts` | This is a consumer integration bug layered on top of Vercel Sandbox, not the Vercel product contract itself |

## 10. Verify whether a consumer implements timeout continuation at all

| First checks                                                                                             | Local files                                                                                                                                                                 | Likely conclusion                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the runtime throw a retryable timeout error and enqueue continuation, or only log timeout and fail? | `packages/junior/src/chat/respond.ts`, `packages/junior/src/chat/runtime/turn.ts`, `packages/junior/src/chat/app/production.ts`, `specs/agent-session-resumability-spec.md` | Junior currently implements auth-driven resume, but not production timeout continuation. That makes sandbox reuse and early ID persistence more important |
