---
name: core-drift
description: Check the core code that copies or must match main's chat code for drift against main, and port or record each change. Use for the periodic core drift check, and before core-next merges to main. Do not use for normal core changes or for main-only work.
---

# Core drift

Core (`packages/junior/src/core/`) copies some chat code from main, or must
behave the same. Main keeps changing, so check it against main.

Last checked main SHA: `1fbcafbe001d809f3cfd23184ca161a4c70ec153`

## Inventory

Paths are under `packages/junior/`.

| Core file | Main source | Must match |
| --- | --- | --- |
| `src/core/model/client.ts` | `src/chat/reasoning-level.ts` | Reasoning levels and the `none` to `off` mapping |
| `src/core/turn/queue.ts` | `src/chat/task-execution/vercel-queue.ts`, `src/chat/task-execution/vercel-callback.ts` | `queue.publish` and `queue.process` attributes, the rejected-message log attributes |
| `src/core/tool-execution-environment/vercel.ts`, `docker.ts` | `src/chat/sandbox/session.ts`, `src/chat/sandbox/vercel/provider.ts`, `src/chat/sandbox/docker/provider.ts`, `src/chat/sandbox/egress/` | Sandbox session, snapshot, timeout, `persistent`, egress credentials per Actor |
| `src/core/tool-execution-environment/instrument.ts` | `src/chat/sandbox/session.ts`, `src/chat/sandbox/sandbox.ts` | `sandbox.*` span names and `app.sandbox.*` attributes |
| `src/core/turn/step.ts` | `src/chat/tool-support/pi-tool-adapter.ts`, `src/chat/tools/execution/tool-error-handler.ts`, the `@earendil-works/pi-agent-core` pin in `package.json` (`dist/agent-loop.js`) | Tool error results and their text, the tool error contract, `gen_ai.execute_tool` attributes, stop reason handling |
| `src/core/telemetry.ts` and every span and log name in `src/core/` | `TELEMETRY.md` at the repo root, `src/chat/agent/index.ts` | Span, metric, log, and attribute names |

The model span is imported from `src/chat/pi/traced-stream.ts`, not copied, so
it cannot drift.

## Known differences

Record a difference here when you do not port it. Remove it when core matches.

- `gen_ai.execute_tool`: core names the span `gen_ai.execute_tool`, not
  `execute_tool <tool>`, has fewer attributes, and sets no error status on a
  failed tool.
- No `gen_ai.invoke_agent` span.
- No exception log when a Turn fails.
- No log context on core spans and logs.
- `queue.process` has no `app.worker.outcome`.
- Renamed sandbox spans: core has `sandbox.exec`, `sandbox.read_file`, and
  `sandbox.write_file`. Main has `bash` (op `process.exec`),
  `sandbox.readFile` (op `sandbox.fs.read`), and `sandbox.writeFile` (op
  `sandbox.fs.write`).
- No `agent.step.prepare` span.
- Core gives `createTracedStreamFn` no `endAttributes`, so its
  `gen_ai.chat` span has fewer end attributes than main's agent loop.
- Core sandboxes and containers are persistent. Main's Turn sandboxes are
  `persistent: false`. Core has no network policy, no egress credentials per
  Actor, and no sandbox `resources`.

## Check procedure

1. Run `git fetch origin`.
2. List the main commits since the last check for every main source:

   ```bash
   git log --oneline <last-checked-sha>..origin/main -- \
     TELEMETRY.md packages/junior/package.json \
     packages/junior/src/chat/reasoning-level.ts \
     packages/junior/src/chat/task-execution/vercel-queue.ts \
     packages/junior/src/chat/task-execution/vercel-callback.ts \
     packages/junior/src/chat/sandbox/session.ts \
     packages/junior/src/chat/sandbox/sandbox.ts \
     packages/junior/src/chat/sandbox/vercel/provider.ts \
     packages/junior/src/chat/sandbox/docker/provider.ts \
     packages/junior/src/chat/sandbox/egress \
     packages/junior/src/chat/tool-support/pi-tool-adapter.ts \
     packages/junior/src/chat/tools/execution/tool-error-handler.ts \
     packages/junior/src/chat/agent/index.ts
   ```

3. Read the diff of each commit. For each change to a "Must match" item,
   port it to the core file, or add it to "Known differences".
4. When you add a core file that copies or must match main, add its row and
   its main sources to the command.
5. Set "Last checked main SHA" to the `origin/main` SHA that you checked.
