# AgentHarness and Sessions

Open this when using Pi sessions, skills, prompt templates, compaction, execution helpers, or the current `AgentHarness` scaffold.

## Published readiness

Pi `0.84.0` replaced the legacy harness and session APIs with a v4 lane-based session model and an `AgentHarness` v2 scaffold. In published `0.84.1`, the types describe the intended surface, but most operation paths reject with `HarnessNotImplemented`.

Use these production paths now:

- Use bare `Agent` for model turns, tools, queues, events, and aborts.
- Use `Session`, `SessionTree`, and a `SessionRepo` for durable transcript and tree storage.
- Use exported skill, prompt-template, compaction, branch-summary, search, environment, and tool helpers directly when they fit.
- Use `AgentHarness` only for scaffold development or implemented configuration and session access. Verify source before each use.

Do not restore the removed pre-`0.84` harness API or add compatibility wrappers unless the user asks for a migration.

## Create the scaffold

Call `await AgentHarness.create(options)`. The constructor is private. Creation returns `{ harness, suspended }` and currently rejects with `HarnessNotImplemented("create.restore")` when the session already has durable records.

| Required or common option | Current purpose                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `session`                 | A v4 `Session`, not a legacy session repository wrapper.                                     |
| `models`                  | Required `pi-ai` `Models` collection for provider calls.                                     |
| `model`                   | Required initial model.                                                                      |
| `thinkingLevel`           | Initial thinking level.                                                                      |
| `tools`, `toolContext`    | Available tools and an optional static or per-turn application context source.               |
| `activeToolNames`         | Initial active tool subset.                                                                  |
| `systemPrompt`            | Static string or zero-argument async provider.                                               |
| `resources`               | Skills and prompt templates.                                                                 |
| Request policy            | `streamOptions`, `retry`, `compaction`, `toolExecution`, `steeringMode`, and `followUpMode`. |
| Runtime control           | `drive`, `toProviderMessages`, `entryProjectors`, and telemetry `context`.                   |

`env` and `getApiKeyAndHeaders` are not constructor options. Provider auth belongs in the required `Models` collection. `ExecutionEnv` is used by standalone environment and tool helpers.

## Implemented scaffold methods

Published `0.84.1` implements only a narrow subset:

- `getLeafId()` through the current session.
- Get and set model, thinking level, active tool names, tools, resources, stream options, retry policy, compaction settings, and queue modes.
- Read the `session` tree.
- `close()`.

The following paths currently reject with `HarnessNotImplemented`:

- Runs: `prompt`, `skill`, `promptFromTemplate`, `resume`.
- Queues and control: `steer`, `followUp`, `nextRun`, `cancelQueued`, `abort`, `waitForIdle`, `runWhenIdle`.
- History work: `compact`, `navigateTree`, `recordUsage`.
- Driving and observation: `peekAction`, `executeAction`, `runToCompletion`, `watch`, `watchSession`, `hooks.on`, and `events.on`.
- Lanes: `lane`, `createLane`, and `lanes`.

Do not describe declared `RunResult`, `QueueResult`, or hook behavior as executable until the published implementation supports it.

## Current declared vocabulary

Use these names when reviewing or developing the scaffold:

- The default lane is `main`. `AgentLane` owns prompts, queues, navigation, model settings, active tools, and a `SessionTree` view.
- Queue names are `steer`, `followUp`, and `nextRun`. The removed name `nextTurn` is not current.
- Hook names include `before_run`, `before_resume`, `before_run_end`, `transform_context`, `before_request`, `before_payload`, `after_response`, `before_tool`, `after_tool`, `before_compaction`, and `before_navigation`.
- Expected operation rejections use typed `Result` values. Harness faults, closure during active work, and unfinished paths can reject with errors.

These names describe the current contract shape. They do not override the readiness limits above.

## Session v4

- `SessionStorage` owns lanes, entries, records, queries, global facts, and statistics.
- `Session` wraps storage and implements the main `SessionTree`. Use `session.view(lane)` for another lane.
- `SessionTree` can read entries and facts, query all entries or one branch, and append messages or custom entries.
- `SessionRepo` defines `create`, `open`, `list`, `delete`, and `fork`.
- Use `InMemorySessionRepo` for process-local storage.
- Use `JsonlSessionRepo` for append-only JSONL storage. It needs a filesystem and sessions root. Its create options include `cwd`.
- Use `@earendil-works/pi-agent-core/session/testing` to run backend conformance checks for a custom repository.

`FileSystem` implementations must include atomic same-filesystem `renameFile()` replacement semantics. `NodeExecutionEnv` from the `/node` entry implements the filesystem and shell environment.

## Verification

1. Confirm npm `latest` and inspect `dist/harness/agent-harness.js` before using a scaffold method.
2. Confirm the session is v4 and uses current `Session`, `SessionStorage`, and `SessionRepo` contracts.
3. Confirm old names such as `nextTurn`, `subscribe`, and legacy hook event names are absent.
4. Treat `HarnessNotImplemented` as an unavailable feature, not a transient runtime failure.
5. Test custom session backends with the `/session/testing` conformance export.
