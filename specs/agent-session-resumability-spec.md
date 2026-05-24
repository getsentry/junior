# Agent Session Resumability Spec

## Metadata

- Created: 2026-03-05
- Last Edited: 2026-05-24

## Changelog

- 2026-03-05: Initial canonical contract for timeout-safe multi-slice assistant execution with Pi in serverless runtimes.
- 2026-03-13: Added auth-driven resume reason and checkpointed dynamic tool state for MCP-backed turns.
- 2026-03-19: Simplified auth resume contract so resumed slices always use `continue()` after trimming trailing uncommitted assistant messages at the auth pause boundary.
- 2026-04-13: Aligned the spec with the current implementation: signed internal timeout-resume callbacks, eager thread-state persistence for sandbox/artifact state, and no automatic resume after visible assistant output has started.
- 2026-04-16: Clarified that Slack delivery now waits for finalized replies, so timeout continuation remains eligible until final visible reply posting begins.
- 2026-04-22: Added `superseded` checkpoint state and clarified that auth checkpoints do not keep `activeTurnId` alive; thread-local pending-auth state decides whether an auth-blocked request is still resumable.
- 2026-05-06: Removed the public Slack auth-pause note; auth pauses complete the live turn after private auth-link delivery.
- 2026-05-13: Clarified turn continuation as an idempotent checkpoint retry path, including user follow-up rescheduling and bounded lock-busy callback retries.
- 2026-05-19: Clarified that Slack auth pauses also post a visible URL-free acknowledgement owned by the Slack delivery contract.
- 2026-05-21: Reframed Pi persistence as an incremental Redis-backed Pi session state store. Checkpoints store metadata and recoverable cursors; materialized `pi_messages` are a read view, not the primary write model.
- 2026-05-24: Added bounded in-process provider retry for transient LLM stream failures before final Slack delivery.

## Status

Active

## Purpose

Define how a single assistant turn is split into resumable execution slices so serverless time limits do not cause message loss, duplicate side effects, or unrecoverable partial state.

## Scope

- Session/slice lifecycle for one assistant turn.
- Durable checkpoint schema at safe resume boundaries.
- Pi replay/continue contract (`agent.state.messages = ...` + `continue`) across slices.
- Signed internal callback contract for timeout continuation.
- Separation between turn-session checkpoints and durable thread state.
- Failure recovery and observability requirements.

## Non-Goals

- Mid-tool-call checkpointing or resume.
- Backward compatibility with legacy `inflight_partial` state.
- Replacing existing tool implementations or Slack transport UX.
- Multi-turn planning policies (this spec covers one assistant turn/session at a time).
- A generic queue/lease/fencing workflow runtime.
- Reconciling or rewriting partially visible Slack assistant output after timeout.

## Contracts

### Spec Boundary

This spec owns how one assistant turn is checkpointed and resumed across execution slices. The full Slack-event-to-agent-to-Slack data flow belongs to `./chat-architecture-spec.md`; user-visible Slack acknowledgements and final delivery belong to `./slack-agent-delivery-spec.md`.

### Identity Model

- `conversation_id`: Stable thread identity (for example, one Slack thread).
- `session_id`: Stable identity for one assistant turn execution attempt.
- `slice_id`: Monotonic integer starting at `1` for each resumed execution chunk in the same session.
- `checkpoint_version`: Monotonic integer incremented on every committed checkpoint write.
- `expected_checkpoint_version`: Version token carried by timeout-resume callbacks so stale callbacks can be dropped.

A conversation can have multiple sessions over time. Each checkpoint version identifies one safe resume boundary for one session.

### Runtime State Partition

- The turn-session store is for Pi execution state and resume metadata only.
- Pi messages are persisted incrementally in the Redis state cache as Pi session message state. Checkpoint metadata stores the recoverable cursor/version, not an independently rewritten transcript blob.
- Durable thread state is the canonical home for mutable turn-local runtime state that can change mid-slice:
  - artifact state (for example active canvas/list context)
  - sandbox identity and dependency-profile hash
  - conversation/thread state and user/assistant message history
- Durable thread state may point at the active or last completed agent session. It must not become a second source of truth for mid-turn Pi execution history.
- Channel configuration is reloaded from the canonical state/configuration services on resume, not copied into the checkpoint payload.
- Sandbox and artifact state must be persisted eagerly as they change so the next slice can rebuild the same environment without depending on successful turn completion.

### Session States

- The checkpoint schema supports `running | awaiting_resume | completed | failed | superseded`.
- The current runtime writes:
  - `awaiting_resume` for timeout/auth safe-boundary checkpoints
  - `completed` when agent execution finishes successfully
  - `superseded` when a newer thread request replaces an older auth-blocked checkpoint
- Terminal user-visible failure is currently reflected in conversation/thread state. The timeout-resume implementation does not rely on a `failed` checkpoint write.

Valid transitions:

1. `awaiting_resume -> completed`
2. `awaiting_resume -> awaiting_resume` (another timeout/auth boundary after a resumed slice)
3. `awaiting_resume -> superseded`
4. `completed` is terminal
5. `superseded` is terminal

The implementation does not currently persist a `running` lease state between slices.

### Safe Resume Boundary Contract

A checkpoint is resumable only when all conditions are true:

1. No tool call is currently in flight.
2. All tool results prior to the boundary are durably recorded.
3. Pi session message state is durably recorded up to the same logical point, and the recoverable cursor points at that boundary.
4. Side-effect markers/idempotency entries for completed actions are committed.

Forbidden boundary:

- Any point between tool request emission and corresponding tool result persistence.

### Checkpoint Payload Contract

Each materialized checkpoint read must include:

- `conversation_id`
- `session_id`
- `slice_id`
- `checkpoint_version`
- `pi_messages`: Canonical message list to replay into Pi, materialized from Pi session state through the checkpoint cursor.
- `state`: one of `running|awaiting_resume|completed|failed|superseded`.
- `updated_at_ms`

Optional checkpoint fields:

- `loaded_skill_names`: Active skills that must be restored before resume when tool availability depends on loaded skills.
- `resume_reason`: `timeout|auth` (when `awaiting_resume`).
- `resumed_from_slice_id`
- `error_message`

The checkpoint metadata does not store:

- artifact state
- sandbox identity
- channel configuration values
- a second durable tool-call log
- a separate visible transcript log
- per-slice deadline metadata

Primary writes persist new stable Pi session messages and then update checkpoint metadata/cursors. Rewriting a whole Pi transcript is a compatibility read shape only.

`inflight_partial` is not part of the checkpoint schema.

### Pi Resume Contract

For slice `n+1`, runtime must:

1. Load latest committed checkpoint for `(conversation_id, session_id)`.
2. Instantiate Pi agent.
3. Restore any checkpointed dynamic tool state required by the wrapper runtime (for example loaded skills).
4. Assign `agent.state.messages = checkpoint.pi_messages`.
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

- Session continuation is the agent recovery model: Junior must be able to rebuild the runtime from durable thread state plus the latest safe checkpoint and continue the same turn session.
- This spec covers checkpoint and resume mechanics. Transport retry/locking is defined in the chat architecture spec, and Slack-visible delivery behavior is defined in the Slack delivery spec.
- Automatic timeout continuation is the current proactive producer of session-continuation work for serverless/Vercel time limits. It is best-effort and currently uses a signed internal HTTP callback, not a generic queue/lease system.
- A timeout checkpoint may be auto-scheduled only when no assistant text has been made visible to the user for the current turn.
- Once visible assistant output has started posting, the runtime must not auto-resume that turn or attempt to rewrite/reconcile the partial output.
- In the current Slack delivery contract, assistant text is not posted until the reply is finalized, so ordinary agent-generation timeouts still occur before visible output begins.
- If a later user message arrives while `activeTurnId` points at an awaiting automatic continuation checkpoint, the live runtime must treat that message as a retry signal for the existing session: reschedule the checkpoint callback, keep `activeTurnId` on the original session, and do not start a new agent turn.
- In that case, the last safe checkpoint may still exist for inspection or operator-driven recovery, but the user-visible turn is allowed to fail only after automatic continuation is impossible or exhausted.

### In-Process Provider Retry Contract

- Transient provider failures reported as terminal assistant messages with `stopReason=error` may be retried inside the same running slice before final Slack delivery.
- Provider retry must not replay the original user prompt. It must remove only the trailing failed assistant message(s), verify the remaining Pi history ends at a continuable boundary (`user` or `toolResult`), persist that safe boundary, then call `continue()`.
- Provider retry is bounded and uses short exponential backoff. If the retry limit is reached, if the error is not classified as transient, or if no safe boundary remains after trimming, the normal provider-failure reply path owns user-visible recovery.
- Provider retry does not create an `awaiting_resume` checkpoint and does not schedule a signed resume callback. If a retried slice later times out, the timeout continuation contract above applies.
- Provider retry is only allowed before final Slack reply delivery. The runtime must not retry by rewriting or reconciling text already posted to Slack.

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
5. Acquire the same per-thread state-adapter lock used by live turn execution. Because callbacks are often scheduled before the scheduling live handler has released the lock, a busy lock must be retried for a short bounded window before the callback reschedules itself.
6. Rebuild turn runtime state from durable thread/configuration state:
   - user message
   - conversation context
   - artifact state
   - sandbox identity
   - channel configuration
7. Restore Pi messages with `agent.state.messages = ...` and resume with `continue()`.
8. If the resumed slice times out again before visible output, schedule a new callback carrying the new `checkpoint_version`.

### Slice Lifecycle

1. User message starts a new `session_id` under `conversation_id`.
2. Slice `1` runs and eagerly persists sandbox/artifact state as those values change.
3. If agent execution finishes, commit `completed`; thread state only points at that session after the final delivery contract has succeeded.
4. If MCP auth pauses at a safe boundary, commit `awaiting_resume` with `resume_reason=auth`; the OAuth callback later consults thread-local pending-auth state before resuming.
5. If timeout is reached before any assistant text is visible, commit `awaiting_resume` with `resume_reason=timeout` and schedule the signed internal timeout-resume callback.
6. The timeout-resume handler validates `expected_checkpoint_version`, rebuilds durable runtime state, restores Pi messages, and calls `continue()`.
7. If the callback loses the per-thread lock because the scheduling live handler is still unwinding, it retries briefly and then reschedules the same checkpoint-version callback without mutating state.
8. If the user pings the thread while the timeout checkpoint is still awaiting resume, the runtime reschedules the existing callback. The ping must not overwrite `activeTurnId` or create a second agent turn.
9. If timeout happens after visible assistant output begins, keep the timeout checkpoint but do not auto-schedule continuation.

## Failure Model

1. Timeout or crash before a stable Pi session message/cursor commit: no new boundary exists; the system can rely on the previous cursor plus whatever thread state had already been eagerly persisted.
2. Checkpoint commit succeeds but the timeout-resume callback is never sent or delivered: there is no sweeper today; continuation requires another explicit callback, a later user follow-up that reschedules the existing checkpoint, or operator intervention.
3. Stale timeout-resume callbacks with an older `expected_checkpoint_version` are dropped without doing work.
4. Duplicate concurrent callbacks for the same thread are serialized by the shared per-thread state-adapter lock. Lock-busy callbacks retry for a short bounded window, then reschedule the same checkpoint-version callback rather than abandoning the awaiting checkpoint.
5. Timeout after visible assistant output begins: automatic continuation is skipped to avoid duplicate/corrupt user-visible output.
6. Repeated resumed timeouts before visible output may produce further `awaiting_resume` checkpoints with incremented `slice_id` and `checkpoint_version`.
7. A later user message after an ungraceful crash may build its prompt history from the active session's latest recoverable Pi session cursor. If the prior session produced assistant text that was not committed to visible thread state, that trailing assistant text must be trimmed from the fresh-turn history view.

## Observability

Required log events/diagnostics:

- `agent_turn_timeout`
- `agent_turn_timeout_resume_checkpoint_failed`
- `agent_turn_timeout_resume_schedule_failed`
- `agent_turn_continuation_retry_schedule_failed`
- `agent_turn_timeout_resume_skipped_after_visible_output`
- `agent_turn_provider_retry`
- `timeout_resume_failed`
- `timeout_resume_handler_failed`
- `timeout_resume_lock_busy`
- `timeout_resume_lock_busy_retrying`
- `slack_turn_continuation_notice_post_failed`

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
3. Unit/integration: a timed-out turn resumes with restored `agent.state.messages` + `continue` and reaches a successful terminal reply when no assistant text had been made visible.
4. Unit/integration: a resumed timeout slice can time out again and schedule the next callback with the new `checkpoint_version`.
5. Unit/integration: a lock-busy timeout callback retries before rescheduling the same checkpoint.
6. Integration: a user follow-up or duplicate delivery during an awaiting automatic continuation checkpoint reschedules the existing session instead of starting a new turn.
7. Unit/integration: auth-driven resume restores the same active skill/MCP tool universe before `continue()`.
8. Unit/integration: eager sandbox/artifact persistence preserves resumed tool context across slices.
9. Unit/integration: fresh follow-up turns can recover Pi history from active/last Pi session state without depending on conversation-state Pi transcript mirroring.
10. Manual/eval: once assistant text is already visible, timeout does not auto-resume or attempt to reconcile partial thread output.
11. Unit/integration: transient provider failures retry with `continue()` from a safe boundary and do not duplicate prior tool execution.

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
