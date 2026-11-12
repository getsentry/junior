Most turns never call `reportProgress`, so Slack keeps rotating the joke loading messages ("Negotiating with the mutex") even while Junior reads files, runs commands, or calls Linear. This PR lets each tool describe its own progress, so the loading state shows the actual step.

**Behavior**

- Tool definitions get an optional `describeProgress(input)` that returns a short label, or `undefined` to keep the current status.
- The tool pipeline sends the label only after action review allows the call. A rejected call never shows progress. `updatePlan` and `reportProgress` statuses now go through the same point, so direct, `executeTool`, and `codemode` calls all behave the same.
- A phase status (`reportProgress`, `updatePlan`, or runtime statuses such as "Compacting context") holds for 8s before tool labels can replace it. Tool labels inside that window are dropped, not queued.
- When a tool finishes, its label goes back to the last phase status, or to generic loading. If the next tool's label arrives within about 1s, it replaces the old label first, so nothing flashes in between. The joke messages still show at turn start until the first status arrives.

**Labels.** They show where the reply goes, so they never echo raw user text, commands, or arguments:

- `bash`: "Running pnpm", the first program only, and only from a short list of well-known programs. It skips `cd` and env assignments and never shows arguments. A script name, a quoted env value, or any other program shows "Running commands".
- `readFile`/`editFile`/`writeFile`: the file's base name only.
- `webFetch`: the hostname only.
- `loadSkill`: names only skills from the available list.
- `callMcpTool`: names only the provider of an active tool, for example "Calling Linear".
- `searchMcpTools`: names only a configured provider, for example "Connecting to Notion".
- Fixed labels for `grep`, `findFiles`, `listDir`, `viewImage`, `webSearch`, `imageGenerate`, `spawnAgent`, and the Slack read tools.

**Not in this PR**

- `describeProgress` is not on `PluginToolDefinition` yet, so plugin tools do not show labels. Adding it is a public `junior-plugin-api` change. I left it for a follow-up so it can be released and then used per plugin (github, google, vercel, memory).
- There is no Slack integration test for the event wiring from the tool pipeline to `setStatus`. `test-architecture:check` does not allow tests in `packages/junior/tests` that run the agent. Coverage is the pipeline component test, the codemode scenario, and the scheduler unit tests.
- With parallel tool calls, the first call to finish drops the label even if another call is still running, until the next tool label arrives.

Local runs: the integration failures I saw (5s timeouts, S3 and BullMQ connection errors) also fail on `main` in this sandbox.
