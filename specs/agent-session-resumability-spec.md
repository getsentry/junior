# Agent Session Resumability Spec

## Metadata

- Created: 2026-03-05
- Last Edited: 2026-03-05

## Changelog

- 2026-03-05: Initial canonical contract for timeout-safe multi-slice assistant execution with Pi in serverless runtimes.

## Status

Active

## Purpose

Define how a single assistant turn is split into resumable execution slices so serverless time limits do not cause message loss, duplicate side effects, or unrecoverable partial state.

## Scope

- Session/slice lifecycle for one assistant turn.
- Durable checkpoint schema at safe resume boundaries.
- Pi replay/continue contract (`replaceMessages` + `continue`) across slices.
- Queue, lease, and idempotency contracts for serverless orchestration.
- Failure recovery and observability requirements.

## Non-Goals

- Mid-tool-call checkpointing or resume.
- Backward compatibility with legacy `inflight_partial` state.
- Replacing existing tool implementations or Slack transport UX.
- Multi-turn planning policies (this spec covers one assistant turn/session at a time).

## Contracts

### Identity Model

- `conversation_id`: Stable thread identity (for example, one Slack thread).
- `session_id`: Stable identity for one assistant turn execution attempt.
- `slice_id`: Monotonic integer starting at `1` for each resumed execution chunk in the same session.
- `checkpoint_version`: Monotonic integer incremented on every committed checkpoint write.

A conversation can have multiple sessions over time, but only one active session may hold a lease at once.

### Session States

- `running`: A worker currently owns the lease and executes a slice.
- `awaiting_resume`: Slice exited at a safe boundary and a continuation must run.
- `completed`: Assistant turn finished and terminal output is committed.
- `failed`: Terminal unrecoverable failure (manual/operator intervention or hard policy limit).

Valid transitions:

1. `running -> awaiting_resume`
2. `running -> completed`
3. `running -> failed`
4. `awaiting_resume -> running`

No other transitions are valid.

### Safe Resume Boundary Contract

A checkpoint is resumable only when all conditions are true:

1. No tool call is currently in flight.
2. All tool results prior to the boundary are durably recorded.
3. Pi message history is durably recorded up to the same logical point.
4. Side-effect markers/idempotency entries for completed actions are committed.

Forbidden boundary:

- Any point between tool request emission and corresponding tool result persistence.

### Checkpoint Payload Contract

Each checkpoint must include:

- `conversation_id`
- `session_id`
- `slice_id`
- `checkpoint_version`
- `pi_messages`: Canonical message list to replay into Pi.
- `tool_call_log`: Ordered committed tool calls and results.
- `transcript_log`: Ordered committed user/assistant visible messages.
- `state`: one of `running|awaiting_resume|completed|failed`.
- `resume_reason`: `timeout|preempted|retry|operator` (when `awaiting_resume`).
- `deadline_at`: hard deadline for the current slice.
- `updated_at`

`inflight_partial` is not part of the checkpoint schema.

### Pi Resume Contract

For slice `n+1`, runtime must:

1. Load latest committed checkpoint for `(conversation_id, session_id)`.
2. Instantiate Pi agent.
3. Call `replaceMessages(checkpoint.pi_messages)`.
4. Call `continue()` to resume generation/tool loop.

If the previous slice timed out after producing uncommitted partial assistant text, that text may be regenerated in the next slice. User-visible output must only include committed transcript content.

### Slice Deadline And Continuation Contract

- Every slice has:
  - `soft_deadline_ms`: stop at next safe boundary and checkpoint.
  - `hard_deadline_ms`: process-level timeout guard.
- On soft deadline hit at a safe boundary:
  1. Commit checkpoint with `state=awaiting_resume` and incremented `slice_id` for next run.
  2. Enqueue continuation task with `(conversation_id, session_id, expected_checkpoint_version)`.
  3. Release lease.

### Lease And Concurrency Contract

- Lease key is `(conversation_id, session_id)`.
- Lease must include a fencing token (monotonic lease epoch).
- Only lease holder with current fencing token may commit checkpoint updates.
- Concurrent worker without valid lease must exit without side effects.

### Queue Contract

Continuation enqueue payload:

- `conversation_id`
- `session_id`
- `resume_from_slice_id`
- `expected_checkpoint_version`
- `enqueued_at`
- `attempt`

Queue consumers must reject stale messages where `expected_checkpoint_version` is older than durable checkpoint version.

### Conversation Flow

1. User message starts a new `session_id` under `conversation_id`.
2. Worker acquires lease and runs slice `1`.
3. If turn finishes, commit `completed` and release lease.
4. If time budget is reached at safe boundary, commit `awaiting_resume`, enqueue continuation, release lease.
5. Next worker acquires lease, validates checkpoint version, restores Pi messages, calls `continue()`, and runs next slice.
6. Repeat until `completed` or `failed`.

This loop allows unbounded slice count for long-running turns.

## Failure Model

1. Worker crash before checkpoint commit: no new boundary exists; next run resumes from previous committed checkpoint.
2. Crash after checkpoint commit but before enqueue: sweeper detects `awaiting_resume` sessions without queued task and enqueues continuation.
3. Duplicate queue delivery: lease + checkpoint version check make continuation idempotent.
4. Stale worker commit attempt: fencing token mismatch; commit rejected.
5. Repeated slice timeout without progress: mark `failed` after policy limit (`max_slices` or `max_wall_time_ms`).

## Observability

Required events:

- `agent.session.started`
- `agent.slice.started`
- `agent.slice.checkpointed`
- `agent.slice.resumed`
- `agent.session.completed`
- `agent.session.failed`
- `agent.session.stale_message_dropped`

Required attributes on slice/session events when available:

- `app.ai.conversation_id`
- `app.ai.session_id`
- `app.ai.slice_id`
- `app.ai.checkpoint_version`
- `app.ai.resume_reason`
- `app.ai.lease_epoch`
- `app.ai.timeout.soft_ms`
- `app.ai.timeout.hard_ms`
- `app.ai.outcome`

## Verification

1. Unit: checkpoint version/fencing/token rules reject stale commits.
2. Unit: safe-boundary validator rejects mid-tool-call checkpoints.
3. Integration: forced timeout at safe boundary resumes with `replaceMessages` + `continue` and reaches same terminal output.
4. Integration: duplicate continuation message does not produce duplicate tool side effects.
5. Integration: crash-after-commit-before-enqueue is recovered by sweeper.
6. Eval: long-running thread surpassing single serverless timeout completes across multiple slices without user-visible corruption.

## Related Specs

- [Harness Agent Spec](./harness-agent-spec.md)
- [Durable Slack Thread Workflows Spec](./durable-workflows-spec.md)
- [Agent Execution Spec](./agent-execution-spec.md)
- [Logging Spec Index](./logging/index.md)

## Prior Art

- Pi ecosystem references:
  - <https://pi.dev/>
  - <https://github.com/badlogic/pi-mono>
- LangGraph durable execution and checkpointing:
  - <https://docs.langchain.com/oss/javascript/langgraph/durable-execution>
- Inngest durable step execution and checkpointing:
  - <https://www.inngest.com/docs/learn/how-functions-are-executed>
  - <https://www.inngest.com/docs/setup/checkpointing>
- Vercel Workflow durability model (`"use workflow"`/`"use step"`):
  - <https://vercel.com/docs/workflow>
- AWS SQS dead-letter and redrive policy patterns:
  - <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html>
- Azure Durable Functions orchestration checkpoints and replay:
  - <https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-orchestrations>
