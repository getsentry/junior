# Chat Runtime

`packages/junior/src/chat` turns source events into durable agent runs and
delivers finalized replies. Code, runtime schemas, and tests are authoritative;
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
6. `egress/` and provider adapters deliver the finalized reply.
7. Successful delivery commits the visible assistant message and durable turn
   outcome.

The local CLI uses `local/runner.ts` directly rather than pretending to be a
mailbox-backed provider.

## Ownership

- `app/`: composition root only.
- `ingress/`: source parsing, classification, and routing.
- `task-execution/`: mailbox, queue, lease, worker, and recovery.
- `runtime/`: turn orchestration and destination-neutral delivery planning.
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

- **Conversation**: durable identity shared by visible messages and agent state.
- **Turn**: one response-producing execution for accumulated user input.
- **Run**: one bounded attempt to advance a turn; a turn may span resumed runs.
- **Step**: one persisted agent-history entry.
- **Context epoch**: replacement boundary after history compaction or handoff.
- **Reply**: finalized destination-visible assistant output.
- **Actor**: human or system principal associated with current work.
- **Credential subject**: principal whose provider authority may be used.
- **Destination**: platform location where output is delivered.

Attribution does not grant authority. `run.actors` records participating actors;
credential issuance still requires the current actor or an explicit delegated
subject.

## Invariants

- User-visible assistant text is delivered only after the run outcome is
  finalized.
- Tool failures remain internal agent-loop data unless the final result exposes
  an appropriate diagnostic.
- Durable state is committed before acknowledging queue work or yielding.
- Unexpected failures propagate to the boundary that owns capture and fallback
  delivery.
- Actor, destination, conversation, and credential context remain explicit
  across asynchronous boundaries.

Follow `../../../../policies/context-bound-systems.md`,
`../../../../policies/provider-boundaries.md`, and the feature READMEs in
this directory.
