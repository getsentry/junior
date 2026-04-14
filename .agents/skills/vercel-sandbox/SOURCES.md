# Sources

Retrieved: 2026-04-13
Skill class: `integration-documentation`
Selected profile: `references/examples/documentation-skill.md`

## Source inventory

| Source                                                                                    | Trust tier | Confidence | Contribution                                                                                                      | Usage constraints                                           |
| ----------------------------------------------------------------------------------------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `AGENTS.md`                                                                               | canonical  | high       | Repo conventions, investigation-first workflow, testing constraints                                               | Repo-local guidance                                         |
| `.agents/skills/skill-writer/SKILL.md`                                                    | canonical  | high       | Required workflow for synthesis, authoring, evaluation, and validation                                            | Process source                                              |
| `.agents/skills/skill-writer/references/mode-selection.md`                                | canonical  | high       | Skill classification and required outputs                                                                         | Process source                                              |
| `.agents/skills/skill-writer/references/synthesis-path.md`                                | canonical  | high       | Coverage matrix and depth gates for integration-documentation skills                                              | Process source                                              |
| `.agents/skills/skill-writer/references/authoring-path.md`                                | canonical  | high       | Required artifact set and provenance expectations                                                                 | Process source                                              |
| `.agents/skills/skill-writer/references/description-optimization.md`                      | canonical  | high       | Trigger-precision constraints for the description                                                                 | Process source                                              |
| `.agents/skills/skill-writer/references/evaluation-path.md`                               | canonical  | high       | Lightweight evaluation rubric                                                                                     | Process source                                              |
| `.agents/skills/nitro/SKILL.md`                                                           | canonical  | medium     | Local style reference for a repo-local integration-documentation skill                                            | Structure reference only                                    |
| `.agents/skills/vercel-queues/SKILL.md`                                                   | canonical  | medium     | Local style reference for a Vercel-focused integration skill                                                      | Structure reference only                                    |
| `https://vercel.com/docs/vercel-sandbox/`                                                 | canonical  | high       | Product overview, positioning, auth, runtimes, and feature map                                                    | Landing page; not enough alone for API details              |
| `https://vercel.com/docs/vercel-sandbox/concepts`                                         | canonical  | high       | Stable lifecycle semantics: active sandboxes are temporary and stopped sandboxes lose their filesystem            | Web source; verify against installed SDK when APIs differ   |
| `https://vercel.com/docs/vercel-sandbox/concepts/snapshots`                               | canonical  | high       | Stable snapshot semantics, expiration, and stop-on-snapshot behavior                                              | Web source; snapshot-specific                               |
| `https://vercel.com/docs/vercel-sandbox/working-with-sandbox`                             | canonical  | high       | Official stable docs for timeout defaults and extending timeout                                                   | Web source; subject to doc updates                          |
| `https://vercel.com/docs/vercel-sandbox/sdk-reference`                                    | canonical  | high       | Official stable docs for `Sandbox.create`, `Sandbox.get`, and active-sandbox retrieval semantics                  | Web source; subject to doc updates                          |
| `https://vercel.com/docs/vercel-sandbox/pricing/`                                         | canonical  | medium     | Runtime ceilings and limits by Vercel plan                                                                        | Limits can change; re-check for production advice           |
| `https://vercel.com/changelog/vercel-sandbox-persistent-sandboxes-beta`                   | canonical  | high       | Official beta persistence model: named sandboxes, automatic snapshots on stop/timeout, resume by name             | Beta-only behavior; do not apply unless repo uses beta APIs |
| `packages/junior/package.json`                                                            | canonical  | high       | Current repo dependency declaration for `@vercel/sandbox`                                                         | Repo snapshot at retrieval date                             |
| `node_modules/.pnpm/@vercel+sandbox@1.9.0/node_modules/@vercel/sandbox/dist/sandbox.d.ts` | canonical  | high       | Installed stable SDK API surface: `sandboxId`, `Sandbox.get`, `extendTimeout`, `snapshot`, snapshot-backed create | Current installed API snapshot                              |
| `node_modules/.pnpm/@vercel+sandbox@1.9.0/node_modules/@vercel/sandbox/README.md`         | canonical  | high       | Stable SDK lifecycle and timeout defaults                                                                         | Current installed package docs                              |
| `packages/junior/src/chat/config.ts`                                                      | canonical  | high       | Turn timeout vs function timeout budget logic                                                                     | Repo implementation                                         |
| `packages/junior/src/chat/app/production.ts`                                              | canonical  | high       | Explicit statement that timeout checkpoints are not resumed in production                                         | Repo implementation                                         |
| `packages/junior/src/chat/runtime/thread-state.ts`                                        | canonical  | high       | Persistence format for `app_sandbox_id` and dependency profile hash                                               | Repo implementation                                         |
| `packages/junior/src/chat/runtime/turn-preparation.ts`                                    | canonical  | high       | Restore path that reads persisted sandbox metadata into the next turn                                             | Repo implementation                                         |
| `packages/junior/src/chat/runtime/reply-executor.ts`                                      | canonical  | high       | Success-path persistence of sandbox metadata and failure-path omission                                            | Repo implementation                                         |
| `packages/junior/src/chat/respond.ts`                                                     | canonical  | high       | Timeout handling, auth-pause retry behavior, and sandbox metadata return path                                     | Repo implementation                                         |
| `packages/junior/src/chat/sandbox/session.ts`                                             | canonical  | high       | Sandbox create/get/reuse logic, keepalive, and dependency-profile mismatch invalidation                           | Repo implementation                                         |
| `specs/agent-session-resumability-spec.md`                                                | canonical  | high       | Intended timeout-safe multi-slice execution contract                                                              | Canonical spec; compare against runtime                     |
| `specs/sandbox-snapshots-spec.md`                                                         | canonical  | high       | Local snapshot contract for runtime dependencies vs sandbox creation                                              | Canonical spec; not workspace persistence                   |
| `https://github.com/getsentry/junior/issues/184`                                          | secondary  | medium     | Concrete motivating failure report for workspace loss between turns                                               | Problem report, not source of truth                         |

## Decisions

| Decision                                                                                   | Status   | Evidence                                                                                    |
| ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------- |
| Classify the skill as `integration-documentation`                                          | adopted  | User goal + `mode-selection.md`                                                             |
| Make stable-vs-beta model detection the first step                                         | adopted  | Installed `sandbox.d.ts` vs persistent-beta changelog                                       |
| Center the skill on Vercel Sandbox itself, not one consumer's bugs                         | adopted  | User correction + official Vercel docs as primary sources                                   |
| Treat consumer code as a secondary integration example                                     | adopted  | Junior runtime files are useful for app-specific debugging but are not the product contract |
| Emphasize that snapshots are not workspace durability                                      | adopted  | `specs/sandbox-snapshots-spec.md` + stable SDK docs + installed `snapshot()` contract       |
| Keep the skill repo-local under `.agents/skills/` instead of shipping a new plugin package | adopted  | User asked for a local skill first; no release-package work needed for this step            |
| Cover stable lifecycle, snapshotting, plan limits, and persistent beta in one skill        | adopted  | Vercel overview, concepts, snapshot docs, pricing, SDK reference, beta changelog            |
| Hardcode beta package versions in the skill body                                           | rejected | Too time-sensitive; instruct callers to confirm installed SDK and current docs instead      |

## Coverage matrix

| Dimension                                   | Coverage status | Evidence                                                                                                |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| API surface and behavior contracts          | complete        | Installed `sandbox.d.ts`, overview, concepts, snapshot docs, stable SDK docs, persistent-beta changelog |
| Configuration/runtime options               | complete        | Stable docs, pricing/limits docs, installed types, local consumer examples                              |
| Common downstream use cases                 | complete        | Official product use cases, snapshot docs, active-reuse docs, local consumer example in Junior          |
| Known issues/failure modes with workarounds | complete        | Stable docs, snapshot docs, pricing limits, local consumer runtime files                                |
| Version/migration variance                  | complete        | Repo dependency declaration, installed stable SDK, persistent-beta changelog                            |

## Open gaps

- Exact beta type signatures are not vendored in this repo because the repo still uses stable 1.x.
- Plan-specific Vercel timeout ceilings can change; confirm against live docs when making production recommendations.
- If the repo upgrades to beta 2.x, refresh this skill so the local type surface is cited directly instead of via changelog.

## Stopping rationale

All required integration-documentation dimensions are covered at `complete` status.

Additional retrieval is currently low-yield because:

1. The current repo behavior is already pinned by local source code and installed stable SDK types.
2. The key product variance is already captured by official stable docs, snapshot docs, pricing docs, and the persistent-beta changelog.
3. Remaining uncertainty is future-version drift, which is best handled by re-checking installed types at use time rather than adding more static material now.
