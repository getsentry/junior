# Chat Runtime

`packages/junior/src/chat` turns source events into durable agent runs and
delivers completed assistant messages. Code, runtime schemas, and tests are authoritative;
this file records ownership boundaries that are difficult to infer from one
file.

## Flow

1. `ingress/` parses, classifies, and normalizes source events.
2. Mailbox-backed sources append work and send a queue nudge through
   `task-execution/`.
3. A worker acquires the conversation lease, drains pending input, and restores
   persisted conversation state.
4. `runtime/` prepares and orchestrates the run; `agent/` owns Pi execution.
5. Tools, plugins, credentials, sandbox, and MCP operate within harness-owned
   actor and destination context.
6. `agent/` emits every completed, tool-free visible assistant message through
   one awaited delivery port; provider adapters deliver and record each message
   in order. Tool-bearing assistant text remains internal to the agent loop.
7. The completed run result supplies diagnostics and artifacts; successful
   delivery or intentional no-reply completion commits the durable turn outcome.

The local CLI uses `local/runner.ts` directly rather than pretending to be a
mailbox-backed provider.

## Ownership

- `app/`: composition root only.
- `ingress/`: source parsing, classification, and routing.
- `task-execution/`: mailbox, queue, lease, worker, and recovery.
- `runtime/`: turn orchestration and provider-neutral delivery callbacks.
- `agent/` and `pi/`: model execution and Pi state conversion.
- `services/`: consumer-owned domain decisions.
- `state/` and `conversations/`: persistence by concern.
- `slack/` and `local/`: platform adapters.
- `plugins/`, `credentials/`, `sandbox/`, and `mcp/`: external capability
  boundaries.

Provider modules must not import runtime orchestration. Runtime and service
modules depend on small injected ports rather than provider implementations or
the production singleton.

## Vocabulary

- **Conversation**: durable identity shared by messages and agent state.
- **Turn**: one response-producing execution for accumulated user input.
- **Run**: one bounded attempt to advance a turn; a turn may span resumed runs.
- **Step**: one persisted agent-history entry.
- **History replacement**: explicit agent-history reset after compaction or handoff.
- **Reply**: one destination-visible assistant message owned by delivery code.
- **Actor**: human or system principal associated with current work.
- **Credential subject**: principal whose provider authority may be used.
- **Destination**: platform location where output is delivered.

Attribution does not grant authority. `run.actors` records participating actors;
credential issuance still requires the current actor or an explicit delegated
subject. Scheduled-task creator identity may authorize task-scoped credential
delegation without becoming the execution actor or a general task owner.

## Invariants

- Each completed tool-free visible assistant message is delivered before the
  run advances; assistant output handling settles before the turn is finalized.
- Tool-bearing assistant text stays in agent history but is not destination
  output; explicit progress uses the runtime status surface.
- Tool failures remain internal agent-loop data unless the final result exposes
  an appropriate diagnostic.
- Durable state is committed before acknowledging queue work or yielding.
- Cooperative yield preserves the exact agent history and occurs only at a user
  or tool-result tail. Unlike timeout or auth recovery, it never rolls history
  back past delivered assistant output.
- Unexpected failures propagate to the boundary that owns capture and fallback
  delivery.
- Actor, destination, conversation, and credential context remain explicit
  across asynchronous boundaries.

Follow `../../../../policies/context-bound-systems.md`,
`../../../../policies/provider-boundaries.md`, and the feature READMEs in
this directory.
