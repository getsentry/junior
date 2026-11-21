# Sources

Retrieved: 2026-11-14
Published baseline: `@earendil-works/pi-agent-core@1.5.2`, with its exact dependencies `@earendil-works/pi-ai@1.5.2` and `@earendil-works/pi-schema@1.5.2`
Upstream release commit: `b4afdddf44e059c67ccf5097e5317d913521b470` ("Release v1.5.2")
Upstream changelog commit: `4438c58ba2208a8a5d0d27f0ca0b8139748f8ff3` (latest `packages/agent/CHANGELOG.md` change on `main`)
Skill class: `integration-documentation`
Primary execution shape: `reference-backed-expert`
Scope: Pi package guidance only. Consuming-product contracts remain out of scope.

## Source inventory

| Source                                                                                              | Trust      | Contribution                                                                                                                                                                            | Constraint                                              |
| --------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| npm metadata for `@earendil-works/pi-agent-core`                                                    | canonical  | Confirmed `latest` `1.5.2` (published 2026-11-10), package identity, repository, and exact `pi-ai`/`pi-schema` `1.5.2` dependencies                                                     | Re-check before each material update                    |
| Published `1.5.2/package.json` and `README.md`                                                      | canonical  | Confirmed root-only exports, Node `>=22.19.0`, required `streamFn`, transcript-owned system prompt and tools, queues, tools, and loop use                                               | Published contract and public intent                    |
| Published `1.5.2/dist/agent.d.ts`, `agent.js`, `stream-fn.*`, and `index.d.ts`                      | canonical  | Confirmed options, read-only `systemPrompt`, `reset()` and continuation guards, queues, `peekQueuedMessages()`, listener settlement, and the `setDefaultStreamFn` fallback              | Implementation resolves declaration ambiguity           |
| Published `1.5.2/dist/types.d.ts` and `agent-loop.*`                                                | canonical  | Confirmed `StreamFn` over `TranscriptContext`, turn hooks, loop signatures, `runToolCall`, tool validation order, `isError`, `structuredContent`, `durationMs`, termination, and events | Published contract and behavior                         |
| Published `1.5.2/dist/proxy.*`                                                                      | canonical  | Confirmed proxy options, including `disableContinuation`, and the `AssistantMessageEventStream` return type                                                                             | Published contract                                      |
| Published `@earendil-works/pi-ai@1.5.2` `dist/types.d.ts`, `models.d.ts`, and `utils/validation.js` | canonical  | Confirmed `SystemMessage`, `TranscriptContext`, `Models.streamSimple`, `ClientIdentity`, and tool-argument validation through `pi-schema` `compile(..., { coerce: true })`              | Only the parts that the skill's guidance relies on      |
| Upstream `packages/agent/CHANGELOG.md` at the changelog commit                                      | primary    | Captured changes from `0.84.1` through `1.5.2`, including the `0.84.2` proxy fix, `finishTurn`, the `1.0.0` harness removal, and the `1.5.0` tool-schema change                         | Unreleased entries are evidence, not published contract |
| Local Pi catalog and consumers                                                                      | supporting | Confirmed this repo pins `1.5.2` and uses `prepareNextTurnWithContext`                                                                                                                  | Product dependency changes are outside the skill docs   |
| Local `skill-writer` workflow, repository instructions, and validators                              | canonical  | Required material synthesis, precision, trigger, source, and validation passes                                                                                                          | Authoring-process source                                |

## Decisions

| Decision                                                                                       | Status   | Evidence                                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| Keep the skill Pi-only                                                                         | adopted  | Existing scope and user request                                                                           |
| Target npm `latest` as the runtime contract                                                    | adopted  | Existing policy and npm metadata                                                                          |
| Treat upstream `main` as unreleased evidence                                                   | adopted  | Upstream `main` has an unreleased abort fix that `1.5.2` lacks                                            |
| Keep the reference-backed shape and replace existing leaves                                    | adopted  | Routes remain distinct; no new lookup need exists                                                         |
| Require explicit `streamFn` in current integrations                                            | adopted  | Published declarations and README                                                                         |
| Prefer `prepareNextTurnWithContext` for context-aware `Agent` work                             | adopted  | Published `AgentOptions`                                                                                  |
| Guard `reset()` with idle state                                                                | adopted  | `1.5.2` `agent.js` `reset()` and the `0.84.1` changelog entry                                             |
| Treat the transcript as the owner of the system prompt and tool declarations                   | adopted  | `1.5.2` `AgentState`, `agent.js`, and README                                                              |
| Include tool usage, `isError`, `structuredContent`, late-update, and blocked termination rules | adopted  | Published types, implementation, and changelog                                                            |
| Drop `addedToolNames` guidance                                                                 | adopted  | Neither the `0.99.2` nor the `1.5.2` declarations contain it; tool changes go through `agent.state.tools` |
| Drop harness, session, and compaction guidance                                                 | adopted  | `1.0.0` removed them from the package                                                                     |
| Add old-package migration or compatibility wrappers by default                                 | rejected | Latest-only scope                                                                                         |
| Change this repo's Pi dependency in the skill-docs commit                                      | rejected | The dependency upgrade is a separate commit with its own tests                                            |

## Source adaptation

| Item              | Decision                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Source intent     | Pi docs and types describe `Agent`, the agent loop, tool execution, and the proxy stream.           |
| Local target      | Cause agents to use only published, implemented behavior and choose the smallest stable Pi surface. |
| Fidelity boundary | Keep current names, signatures, ordering, failure rules, and readiness exact.                       |
| Local replacement | Replace long design prose with routed tables, guardrails, use cases, and failure fixes.             |
| Omitted material  | Omit legacy migration detail, the removed harness, provider catalogs, and product-specific policy.  |
| Rights            | Pi is MIT licensed. This skill paraphrases public facts and does not copy substantial source text.  |

## Coverage matrix

| Dimension                     | Status  | Evidence                                                                                       |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| API surface and behavior      | covered | Published `1.5.2` README, declarations, and implementation                                     |
| Config and runtime options    | covered | `AgentOptions`, `AgentState`, `AgentLoopConfig`, `AgentTool`, and proxy types                  |
| Downstream use cases          | covered | Twelve focused use cases across streaming, proxy, auth, context, queues, tools, and turn hooks |
| Failure modes and workarounds | covered | Published implementation, changelog fixes, and more than eight troubleshooting entries         |
| Version variance              | covered | Changelog from `0.84.1` through `1.5.2`, the repo pin `1.5.2`, and one unreleased `main` fix   |
| Trigger precision             | covered | Should-trigger and should-not-trigger sets below                                               |

## Trigger quality

Should trigger:

- "integrate pi-agent-core Agent into my app"
- "wire Pi text streaming"
- "why does Pi continue() reject?"
- "update our Pi tool hooks"
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

- Upstream `main` after `1.5.2` gives each tool call skipped by a mid-batch abort an `"Operation aborted"` result (earendil-works/pi#9986). `1.5.2` does not include that fix.

## Validation record

- `pnpm skills:check`: pass on 2026-11-14.
- Manual published-package audit on 2026-11-14: manifest, README, `agent`, `agent-loop`, `proxy`, `stream-fn`, and `types` declarations and implementation, the `pi-ai` parts listed above, and the agent changelog.

## Stopping rationale

The source mix covers the published contract, implementation edge behavior, breaking changes, current upstream differences, local consumption, and authoring rules. More retrieval is low value until Pi publishes a new release.
