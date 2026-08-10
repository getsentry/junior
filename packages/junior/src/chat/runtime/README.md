# Chat Runtime

This folder coordinates a chat turn. It loads conversation state, calls the
agent, accepts replies, saves the result, and schedules more work when a turn
must continue later. `../agent/` owns the model and tool loop.

`conversation-only.ts` accepts assistant output into the canonical conversation
log without provider delivery. `../local/runner.ts` adapts the CLI to this path.
Slack keeps its provider preparation and delivery in `reply-executor.ts`.

## Replies

- A completed assistant message without tool calls is sent as a reply.
- Thinking, tool calls, and text attached to tool calls stay internal.
- Progress is shown through the status UI, not as an assistant reply.
- An assistant message is saved only after delivery succeeds.
- A turn that intentionally has no reply records `no_reply`. Missing text alone
  does not count as intentional silence.

## Recovery

A turn can outlive one worker. The runtime saves agent history after input and
after completed tool work, then resumes from the latest saved checkpoint.

- Timeouts, worker yields, authorization pauses, and retryable delivery failures
  can continue the same turn in a later run.
- Timeouts and delivery retries share the turn's normal execution limit.
- Work already present in saved agent history is not repeated.
- The same conversation ID and turn ID are used throughout recovery. If two
  workers try to finish the turn, only the first saved result wins.

Reply delivery is best effort. An explicit provider rejection fails the turn.
A transient failure, or a failure where the provider may have accepted the
reply, resumes from the latest checkpoint and generates the reply again. This
can produce a duplicate reply if the first one actually reached the provider.

## Prompt Context

The core prompt contains stable Junior behavior. The runtime adds the current
source, actor, destination, tools, files, and execution limits. Plugins and
skills may add their own focused instructions, but they do not own runtime
state or credentials.

## Compaction And Model Handoff

Compaction replaces old agent history with retained user messages and a
summary. A model handoff replaces that history and switches models. Both are
saved changes to the same conversation; neither creates a new conversation or
changes the visible message history.

The replacement must keep anything needed to continue the work: unfinished
tasks, important facts, files, completed tool results, and the active actor and
destination.

Integration coverage lives under `packages/junior/tests/integration/runtime/`.
