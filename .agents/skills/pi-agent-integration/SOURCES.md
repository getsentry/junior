# Sources

Retrieved: 2026-08-12
Published baseline: `@earendil-works/pi-agent-core@0.84.1`
Upstream review commit: `9795d602306ef68a97585909e8e79f92a389057b`
Skill class: `integration-documentation`
Primary execution shape: `reference-backed-expert`
Scope: Pi package guidance only. Consuming-product contracts remain out of scope.

## Source inventory

| Source                                                                 | Trust      | Contribution                                                                                  | Constraint                                                |
| ---------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| npm metadata for `@earendil-works/pi-agent-core`                       | canonical  | Confirmed `latest` `0.84.1`, package identity, repository, engine, and publish dates          | Re-check before each material update                      |
| Published `0.84.1/package.json` and `README.md`                        | canonical  | Confirmed exports, required `streamFn`, main `Agent` API, loop use, tools, and event flow     | Published contract and public intent                      |
| Published `0.84.1/dist/agent.d.ts` and `agent.js`                      | canonical  | Confirmed options, state, active-run guards, continuation, queues, and listener settlement    | Implementation resolves declaration ambiguity             |
| Published `0.84.1/dist/types.d.ts` and `agent-loop.*`                  | canonical  | Confirmed stream shape, turn hooks, loop signatures, tools, usage, added tools, and events    | Published contract and behavior                           |
| Published `0.84.1/dist/proxy.*`                                        | canonical  | Confirmed proxy options and published finalized-event behavior                                | Published package contains the noted metadata defect      |
| Published `0.84.1/dist/harness/*`                                      | canonical  | Confirmed session v4 exports, scaffold types, and which `AgentHarness` methods are unfinished | Check implementation, not declarations alone              |
| Upstream `packages/agent/CHANGELOG.md` at review commit                | primary    | Captured breaking changes from `0.78.0` through `0.84.1` and the unreleased proxy fix         | Unreleased entries are evidence, not published contract   |
| Upstream `packages/agent/src` and `packages/agent/docs/harness.md`     | primary    | Compared implemented scaffold behavior with intended lane-based harness design                | Design text cannot imply current runtime readiness        |
| Local Pi catalog and consumers                                         | supporting | Confirmed this repo pins `0.82.1` and already uses `prepareNextTurnWithContext`               | Product dependency upgrades are outside this skill update |
| Local `skill-writer` workflow, repository instructions, and validators | canonical  | Required material synthesis, precision, trigger, source, and validation passes                | Authoring-process source                                  |

## Decisions

| Decision                                                                    | Status   | Evidence                                                        |
| --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| Keep the skill Pi-only                                                      | adopted  | Existing scope and user request                                 |
| Target npm `latest` as the runtime contract                                 | adopted  | Existing policy and npm metadata                                |
| Treat upstream `main` as unreleased evidence                                | adopted  | Published package differs from the upstream unreleased section  |
| Keep the reference-backed shape and replace existing leaves                 | adopted  | Routes remain distinct; no new lookup need exists               |
| Require explicit `streamFn` in current integrations                         | adopted  | Published declarations and README                               |
| Prefer `prepareNextTurnWithContext` for context-aware `Agent` work          | adopted  | Published `AgentOptions`                                        |
| Guard `reset()` with idle state                                             | adopted  | `0.84.1` implementation and changelog                           |
| Include tool usage, added tools, late-update, and blocked termination rules | adopted  | Published types, implementation, and changelog                  |
| Replace legacy harness guidance with session v4 and scaffold readiness      | adopted  | `0.84.0` breaking change and `0.84.1` implementation            |
| Recommend bare `Agent` plus direct session/helpers for production work      | adopted  | Most current `AgentHarness` operations reject as unimplemented  |
| Add old-package migration or compatibility wrappers by default              | rejected | Latest-only scope                                               |
| Upgrade this repo's Pi dependency as part of the skill refresh              | rejected | Separate product change that needs its own implementation tests |

## Source adaptation

| Item              | Decision                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Source intent     | Pi docs and types describe execution, sessions, and the intended lane-based harness.                        |
| Local target      | Cause agents to use only published, implemented behavior and choose the smallest stable Pi surface.         |
| Fidelity boundary | Keep current names, signatures, ordering, failure rules, and readiness exact.                               |
| Local replacement | Replace long design prose with routed tables, guardrails, use cases, and failure fixes.                     |
| Omitted material  | Omit legacy migration detail, unfinished harness internals, provider catalogs, and product-specific policy. |
| Rights            | Pi is MIT licensed. This skill paraphrases public facts and does not copy substantial source text.          |

## Coverage matrix

| Dimension                          | Status  | Evidence                                                                                   |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| API surface and behavior           | covered | Published README, declarations, and implementation                                         |
| Config and runtime options         | covered | `AgentOptions`, `AgentLoopConfig`, proxy types, scaffold options, and session types        |
| Downstream use cases               | covered | Ten focused use cases across streaming, proxy, auth, context, queues, tools, and sessions  |
| Failure modes and workarounds      | covered | Published implementation, changelog fixes, and more than eight troubleshooting entries     |
| Version variance                   | covered | Diff from `0.78.0`, changelog through `0.84.1`, local `0.82.1`, and unreleased `main` note |
| Harness, session, helper readiness | covered | Published harness declarations and implementation plus upstream design comparison          |
| Trigger precision                  | covered | Should-trigger and should-not-trigger sets below                                           |

## Trigger quality

Should trigger:

- "integrate pi-agent-core Agent into my app"
- "wire Pi text streaming"
- "why does Pi continue() reject?"
- "update our Pi tool hooks"
- "use Pi sessions or AgentHarness"
- "proxy Pi model calls"
- "review whether our Pi integration is current"

Should not trigger:

- "write a generic OpenAI streaming adapter"
- "create an unrelated Codex skill"
- "debug a React component"
- "explain TypeBox"
- "change product chat policy without touching Pi"

The description now names concrete Pi APIs and tasks. It keeps generic SDK, skill-authoring, and consuming-product work out of scope.

## Open gaps

- Upstream `main` contains an unreleased fix for `streamProxy()` finalized tool-call metadata. Re-check npm after the next release.
- `AgentHarness` is a moving scaffold. Re-audit declarations and implementation before any harness guidance change.
- This repo still pins Pi `0.82.1`. A dependency upgrade is a separate product change and was not made here.

## Validation record

- Agent Skills quick validator: pass with no warnings on 2026-08-12.
- `pnpm skills:check`: pass for all 17 repository skill directories on 2026-08-12.
- Manual published-package audit: complete for manifest, README, core declarations, core implementation, proxy, harness, sessions, changelog, and current upstream source.

## Stopping rationale

The source mix covers the published contract, implementation edge behavior, breaking changes, current upstream differences, local consumption, and authoring rules. More retrieval is low value until Pi publishes a new release or completes more harness paths.
