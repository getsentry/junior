# Sources

Retrieved: 2026-06-01
Skill class: `integration-documentation`
Primary execution shape: `reference-backed-expert`
Scope: Pi package documentation only; no consuming-product-specific contracts.

## Source inventory

| Source                                                               | Trust tier | Confidence | Contribution                                                                                | Usage constraints                         |
| -------------------------------------------------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| npm metadata for `@earendil-works/pi-agent-core`                     | canonical  | high       | Confirmed latest package name, latest version, repository, dist-tags                        | Re-check before future material API edits |
| `@earendil-works/pi-agent-core@0.78.0/package.json`                  | canonical  | high       | Runtime engine, exports, repository, dependency baseline                                    | Published package snapshot                |
| `@earendil-works/pi-agent-core@0.78.0/README.md`                     | canonical  | high       | Public API intent, event flow, tool execution, continuation, proxy, low-level loop guidance | Published package snapshot                |
| `@earendil-works/pi-agent-core@0.78.0/dist/agent.d.ts`               | canonical  | high       | `AgentOptions`, `Agent` methods, state, queue, lifecycle surface                            | Declaration source of truth               |
| `@earendil-works/pi-agent-core@0.78.0/dist/agent.js`                 | canonical  | high       | Runtime semantics for `continue()`, queue draining, listener settlement, state updates      | Used where README/types were ambiguous    |
| `@earendil-works/pi-agent-core@0.78.0/dist/types.d.ts`               | canonical  | high       | `StreamFn`, message pipeline, tool hooks, queue mode, tool execution, event types           | Declaration source of truth               |
| `@earendil-works/pi-agent-core@0.78.0/dist/agent-loop.d.ts`          | canonical  | high       | Low-level loop signatures and continuation caveat                                           | Declaration source of truth               |
| `@earendil-works/pi-agent-core@0.78.0/dist/agent-loop.js`            | canonical  | high       | Low-level loop ordering, `shouldStopAfterTurn`, `prepareNextTurn`, tool execution internals | Used where README/types were ambiguous    |
| `@earendil-works/pi-agent-core@0.78.0/dist/proxy.d.ts`               | canonical  | high       | `streamProxy` events and serializable proxy options                                         | Declaration source of truth               |
| `@earendil-works/pi-agent-core@0.78.0/dist/harness/*.d.ts`           | canonical  | high       | `AgentHarness`, session, skill, prompt-template, compaction, environment contracts          | Declaration source of truth               |
| `.agents/skills/skill-writer/SKILL.md`                               | canonical  | high       | Required workflow for skill synthesis, authoring, and validation                            | Skill-authoring process source            |
| `.agents/skills/skill-writer/references/mode-selection.md`           | canonical  | high       | Classified this as `integration-documentation`                                              | Process guidance                          |
| `.agents/skills/skill-writer/references/execution-shapes.md`         | canonical  | high       | Selected `reference-backed-expert` shape                                                    | Process guidance                          |
| `.agents/skills/skill-writer/references/synthesis-path.md`           | canonical  | high       | Required source inventory, decisions, coverage, gaps                                        | Process guidance                          |
| `.agents/skills/skill-writer/references/authoring-path.md`           | canonical  | high       | Runtime authoring and precision-pass rules                                                  | Process guidance                          |
| `.agents/skills/skill-writer/references/reference-architecture.md`   | canonical  | high       | Added focused `references/harness.md` as a routed lookup leaf                               | Process guidance                          |
| `.agents/skills/skill-writer/references/spec-template.md`            | canonical  | high       | Added `SPEC.md` for material scope/reference changes                                        | Process guidance                          |
| `.agents/skills/skill-writer/references/description-optimization.md` | canonical  | high       | Trigger quality pass                                                                        | Process guidance                          |
| `.agents/skills/skill-writer/references/registration-validation.md`  | canonical  | high       | Validation expectations                                                                     | Process guidance                          |

## Decisions

| Decision                                                         | Status   | Evidence                                                                           |
| ---------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| Keep the skill Pi-only                                           | adopted  | User direction on 2026-06-01                                                       |
| Target npm `latest` only                                         | adopted  | User direction + npm metadata                                                      |
| Use `@earendil-works/pi-agent-core` as the only package identity | adopted  | Latest package metadata                                                            |
| Remove consuming-product-specific source references              | adopted  | User direction + portability goal                                                  |
| Add a routed harness reference                                   | adopted  | Latest package exports substantial `AgentHarness`, session, skill, compaction APIs |
| Keep `SKILL.md` as router/guardrail layer                        | adopted  | `skill-writer` reference architecture                                              |
| Add `SPEC.md`                                                    | adopted  | Material scope and reference architecture change                                   |
| Add backward compatibility or old package migration guidance     | rejected | Latest-only user direction                                                         |

## Coverage matrix

| Dimension                                   | Coverage status | Evidence                                                                                |
| ------------------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| API surface and behavior contracts          | covered         | `agent.d.ts`, `agent.js`, `types.d.ts`, `agent-loop.d.ts`, `agent-loop.js`, `README.md` |
| Config/runtime options                      | covered         | `AgentOptions`, `AgentLoopConfig`, `AgentHarnessOptions`, package metadata              |
| Common downstream use cases                 | covered         | `README.md`, declarations, runtime implementation                                       |
| Known issues/failure modes with workarounds | covered         | `agent.js`, `agent-loop.js`, type contracts                                             |
| Version/migration variance                  | constrained     | Latest-only package targeting; migration intentionally omitted                          |
| Harness/session/skill/compaction surface    | covered         | `dist/harness/*.d.ts`                                                                   |

## Trigger quality notes

Should trigger:

- "integrate pi-agent-core Agent into my app"
- "stream Pi Agent text deltas into our SDK"
- "how should I use AgentHarness sessions and skills"
- "fix continue() throwing in pi-agent-core"
- "wire streamProxy for Pi"

Should not trigger:

- "write a generic OpenAI API streaming adapter"
- "document a consuming app's chat runtime behavior"
- "create a new Codex skill unrelated to Pi"
- "debug a React component"
- "explain TypeBox generally"

## Open gaps

- Re-run npm package retrieval before the next material update; the skill intentionally follows `latest`.
- Add concrete code examples only after collecting stable upstream examples or tests from the Pi repository. The current runtime guidance is source-backed but example-light.

## Stopping rationale

Further retrieval is low-yield for this pass because published package metadata, README, declarations, and implementation files cover the latest API contracts needed by this Pi-only integration skill.
