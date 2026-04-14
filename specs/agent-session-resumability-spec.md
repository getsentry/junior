# Agent Session Resumability Spec

## Metadata

- Created: 2026-03-05
- Last Edited: 2026-04-13

## Changelog

- 2026-03-05: Initial canonical contract for timeout-safe multi-slice assistant execution with Pi in serverless runtimes.
- 2026-03-13: Added auth-driven resume reason and checkpointed dynamic tool state for MCP-backed turns.
- 2026-03-19: Simplified auth resume contract so resumed slices always use `continue()` after trimming trailing uncommitted assistant messages at the auth pause boundary.
- 2026-04-13: Aligned the spec with the current implementation: signed internal timeout-resume callbacks, eager thread-state persistence for sandbox/artifact state, and no automatic resume after visible assistant output has started.

## Status

Active

## Purpose

Define how a single assistant turn is split into resumable execution slices so serverless time limits do not cause message loss, duplicate side effects, or unrecoverable partial state.

## Scope

- Session/slice lifecycle for one assistant turn.
- Durable checkpoint schema at safe resume boundaries.
- Pi replay/continue contract (`replaceMessages` + `continue`) across slices.
- Signed internal callback contract for timeout continuation.
- Separation between turn-session checkpoints and durable thread state.
- Failure recovery and observability requirements.

## Non-Goals

- Mid-tool-call checkpointing or resume.
- Backward compatibility with legacy `inflight_partial` state.
- Replacing existing tool implementations or Slack transport UX.
- Multi-turn planning policies (this spec covers one assistant turn/session at a time).
- A generic queue/lease/fencing workflow runtime.
- Reconciling or rewriting partially streamed Slack assistant output after timeout.

## Contracts

### Identity Model

- `conversation_id`: Stable thread identity (for example, one Slack thread).
- `session_id`: Stable identity for one assistant turn execution attempt.
- `slice_id`: Monotonic integer starting at `1` for each resumed execution chunk in the same session.
- `checkpoint_version`: Monotonic integer incremented on every committed checkpoint write.
- `expected_checkpoint_version`: Version token carried by timeout-resume callbacks so stale callbacks can be dropped.

A conversation can have multiple sessions over time. Each checkpoint version identifies one safe resume boundary for one session.

### Runtime State Partition

- The turn-session checkpoint store is for Pi transcript state and resume metadata only.
- Durable thread state is the canonical home for mutable turn-local runtime state that can change mid-slice:
  - artifact state (for example active canvas/list context)
  - sandbox identity and dependency-profile hash
  - conversation/thread state and user/assistant message history
- Channel configuration is reloaded from the canonical state/configuration services on resume, not copied into the checkpoint payload.
- Sandbox and artifact state must be persisted eagerly as they change so the next slice can rebuild the same environment without depending on successful turn completion.

### Session States

- The checkpoint schema supports `running | awaiting_resume | completed | failed`.
- The current runtime writes:
  - `awaiting_resume` for timeout/auth safe-boundary checkpoints
  - `completed` when a turn finishes successfully
- Terminal user-visible failure is currently reflected in conversation/thread state. The timeout-resume implementation does not rely on a `failed` checkpoint write.

Valid transitions:

1. `awaiting_resume -> completed`
2. `awaiting_resume -> awaiting_resume` (another timeout/auth boundary after a resumed slice)
3. `completed` is terminal

The implementation does not currently persist a `running` lease state between slices.

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
- `state`: one of `running|awaiting_resume|completed|failed`.
- `updated_at_ms`

Optional checkpoint fields:

- `loaded_skill_names`: Active skills that must be restored before resume when tool availability depends on loaded skills.
- `resume_reason`: `timeout|auth` (when `awaiting_resume`).
- `resumed_from_slice_id`
- `error_message`

The checkpoint does not store:

- artifact state
- sandbox identity
- channel configuration values
- a durable tool-call log
- a separate visible transcript log
- per-slice deadline metadata

`inflight_partial` is not part of the checkpoint schema.

### Pi Resume Contract

For slice `n+1`, runtime must:

1. Load latest committed checkpoint for `(conversation_id, session_id)`.
2. Instantiate Pi agent.
3. Restore any checkpointed dynamic tool state required by the wrapper runtime (for example loaded skills).
4. Call `replaceMessages(checkpoint.pi_messages)`.
5. Resume generation by calling `continue()` to resume generation/tool loop.

For auth-driven pauses and timeout checkpoints, the checkpoint written at the pause boundary must trim any trailing uncommitted assistant-only messages so the restored Pi history is resumable with `continue()`.

If the previous slice timed out after producing uncommitted partial assistant text, that text may be regenerated in the next slice. User-visible output must only include committed transcript content.

### Slice Deadline And Timeout Checkpoint Contract

- Slice execution is bounded by:
  - `AGENT_TURN_TIMEOUT_MS` inside `generateAssistantReply(...)`
  - the platform/function max duration outside the agent loop
- On timeout:
  1. Abort the Pi agent and wait for the in-flight prompt/continue call to settle before snapshotting Pi messages.
  2. If session context exists and a safe boundary can be materialized, commit a timeout checkpoint with:
     - `state=awaiting_resume`
     - incremented `slice_id`
     - incremented `checkpoint_version`
     - `resume_reason=timeout`
     - `resumed_from_slice_id=<previous slice>`
  3. Throw a retryable timeout error carrying `conversation_id`, `session_id`, `slice_id`, and `checkpoint_version`.
  4. If timeout checkpoint persistence fails, fall back to normal non-resumable turn failure behavior.

### Automatic Continuation Contract

- Automatic timeout continuation is best-effort and currently uses a signed internal HTTP callback, not a generic queue/lease system.
- A timeout checkpoint may be auto-scheduled only when no assistant text has been made visible to the user for the current turn.
- Once visible assistant output has started streaming or posting, the runtime must not auto-resume that turn or attempt to rewrite/reconcile the partial output.
- In that case, the last safe checkpoint may still exist for inspection or operator-driven recovery, but the user-visible turn is allowed to fail.

### Internal Timeout-Resume Callback Contract

The timeout-resume callback payload is:

- `conversation_id`
- `session_id`
- `expected_checkpoint_version`

The callback must:

1. Be authenticated with an HMAC signature over the request body plus timestamp.
2. Be rejected when the signature is invalid or too old.
3. Load the checkpoint for `(conversation_id, session_id)`.
4. Exit without work when:
   - no checkpoint exists
   - `state !== awaiting_resume`
   - `resume_reason !== timeout`
   - `checkpoint_version !== expected_checkpoint_version`
5. Acquire the same per-thread state-adapter lock used by live turn execution; if another worker already owns it, exit without mutating state.
6. Rebuild turn runtime state from durable thread/configuration state:
   - user message
   - conversation context
   - artifact state
   - sandbox identity
   - channel configuration
7. Restore Pi messages with `replaceMessages(...)` and resume with `continue()`.
8. If the resumed slice times out again before visible output, schedule a new callback carrying the new `checkpoint_version`.

### Conversation Flow

1. User message starts a new `session_id` under `conversation_id`.
2. Slice `1` runs and eagerly persists sandbox/artifact state as those values change.
3. If the turn finishes, commit `completed` and persist final thread state/output.
4. If MCP auth pauses at a safe boundary, commit `awaiting_resume` with `resume_reason=auth`; the OAuth callback path later restores Pi state and resumes.
5. If timeout is reached before any assistant text is visible, commit `awaiting_resume` with `resume_reason=timeout` and schedule the signed internal timeout-resume callback.
6. The timeout-resume handler validates `expected_checkpoint_version`, rebuilds durable runtime state, restores Pi messages, and calls `continue()`.
7. If timeout happens after visible assistant output begins, keep the timeout checkpoint but do not auto-schedule continuation.

## Failure Model

1. Timeout or crash before checkpoint commit: no new boundary exists; the system can only rely on whatever thread state had already been eagerly persisted.
2. Checkpoint commit succeeds but the timeout-resume callback is never sent or delivered: there is no sweeper today; continuation requires another explicit callback or operator intervention.
3. Stale timeout-resume callbacks with an older `expected_checkpoint_version` are dropped without doing work.
4. Duplicate concurrent callbacks for the same thread are serialized by the shared per-thread state-adapter lock, but there is no delayed retry queue if a callback loses the race for that lock.
5. Timeout after visible assistant output begins: automatic continuation is skipped to avoid duplicate/corrupt user-visible output.
6. Repeated resumed timeouts before visible output may produce further `awaiting_resume` checkpoints with incremented `slice_id` and `checkpoint_version`.

## Observability

Required log events/diagnostics:

- `agent_turn_timeout`
- `agent_turn_timeout_resume_checkpoint_failed`
- `agent_turn_timeout_resume_schedule_failed`
- `agent_turn_timeout_resume_skipped_after_visible_output`
- `timeout_resume_failed`
- `timeout_resume_handler_failed`

Required attributes when available:

- `gen_ai.provider.name`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- `app.ai.turn_timeout_ms`
- `app.ai.resume_conversation_id`
- `app.ai.resume_session_id`
- `app.ai.resume_from_slice_id`
- `app.ai.resume_next_slice_id`
- `app.ai.resume_checkpoint_version`
- `app.ai.conversation_id`
- `app.ai.session_id`
- `messaging.message.id`

## Verification

1. Unit: timeout checkpoints trim trailing assistant-only messages and increment `slice_id`/`checkpoint_version`.
2. Unit: signed timeout-resume callbacks verify successfully and tampered payloads are rejected.
3. Unit/integration: a timed-out turn resumes with `replaceMessages` + `continue` and reaches a successful terminal reply when no assistant text had been made visible.
4. Unit/integration: a resumed timeout slice can time out again and schedule the next callback with the new `checkpoint_version`.
5. Unit/integration: auth-driven resume restores the same active skill/MCP tool universe before `continue()`.
6. Unit/integration: eager sandbox/artifact persistence preserves resumed tool context across slices.
7. Manual/eval: once assistant text is already visible, timeout does not auto-resume or attempt to reconcile partial thread output.

## Related Specs

- [Harness Agent Spec](./harness-agent-spec.md)
- [Durable Slack Thread Workflows Spec](./archive/durable-workflows-spec.md) (archived — unimplemented design)
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
