# Context Compaction Spec

## Metadata

- Created: 2026-05-28
- Last Edited: 2026-05-30

## Purpose

Define how Junior bounds long-running conversation context by replacing reusable model history with a compacted handoff while preserving enough user-authored context for future turns.

## Scope

- Pre-turn compaction of reusable Pi history loaded from the conversation-keyed agent session log.
- Visible Slack conversation-state compaction used for routing, thinking selection, and no-Pi-history prompt background.
- Summary shape, retained-message selection, persistence boundaries, and verification requirements.

## Non-Goals

- Remote or server-side compaction endpoints. Junior owns all summarization, retained-message selection, replacement construction, persistence, and triggers locally.
- User-facing compaction commands, slash commands, or model tools.
- Manual or forced compaction APIs. Future model-handoff orchestration can add a small internal caller when that flow exists.
- Mid-turn compaction while an agent turn is actively generating.
- Compaction while the conversation log has an unconsumed timeout or auth pause.
- Rewriting partially visible Slack assistant output.
- Replacing the timeout/auth resume contract in `./agent-session-resumability.md`.

## Contracts

### Context Authorities

Junior has two different context authorities:

1. Durable Pi history in the conversation-keyed agent session log. This is the model history reused whenever a later message arrives with the same predictable `conversation_id`.
2. Persisted Slack conversation state. This is the visible thread transcript used for routing, thinking selection, assistant titles, and prompt background when no reusable Pi history exists.

Compaction must treat these as separate surfaces. Shrinking Slack conversation state does not shrink model history once turns are seeded from the agent session log.

The durable Pi history is the agent session log defined in `./agent-session-resumability.md`. Compaction may replace the current Pi projection only by appending a deterministic projection event with a synthetic handoff summary; it must not create a parallel summary log, loaded-skill log, provider log, prompt-history cache, or "last session" pointer. The internal `sessionId` is only a conversation-local marker for filtering old projection events after a reset.

### Pi History Compaction

Pre-turn Pi compaction runs only before appending the next user input and only against reusable conversation-log history. It must not compact:

- a conversation log whose latest lifecycle projection is `awaiting_resume`
- active timeout/auth resume pauses
- log projections that need `continue()` semantics
- partial assistant-only tails that have not reached final Slack delivery

When compaction is required, Junior creates a replacement Pi history from:

1. recent real user-authored messages up to the retained-message budget
2. one synthetic user-role handoff summary

This matches the proven shape in Pi coding-agent and Codex: the durable log
remains the source of truth, and compaction changes only the model-visible
projection. Pi coding-agent appends a compaction entry that names the first kept
entry; rebuilding context emits the summary plus the retained tail. Codex builds
replacement model history from selected user messages plus a summary item. Junior
uses `projection_reset` for the same role inside the conversation session log.
That reset advances the current `sessionId`; later entries in the same
conversation carry the new marker, and reducers ignore events from older
sessions.

The `projection_reset` carries per-message provenance aligned one-to-one with
its replacement messages. Retained real user messages preserve their original
instruction actor from the pre-compaction projection; the synthetic handoff
summary is unattributed `context`. Reset provenance that does not align with the
replacement messages fails closed rather than being zipped or truncated.

The replacement history must exclude stale runtime turn context, old capability catalogs, raw image/base64 payloads, and unbounded tool output. Runtime turn context is injected again on the next actual turn by `buildTurnContextPrompt(...)`.

The replacement history must preserve enough session-log evidence to derive required runtime handles, or deliberately omit handles that are no longer valid after compaction. If compaction drops old `loadSkill` results or `mcp_provider_connected` events, the next turn must rediscover/reload those capabilities through normal tools rather than relying on side metadata.

### Handoff Summary

The summary prompt must produce a concise handoff for another model continuing the same thread. It must ask for:

- current outstanding asks
- important decisions, outcomes, and completed work
- durable context, constraints, preferences, identifiers, URLs, artifacts, canvas links, sandbox references, and auth state
- clear next steps and unresolved blockers

The summary must be stored as one model-visible handoff item, not as an accumulating log of compaction records.

When summary input must be bounded before calling the summarizer, Junior must omit older context before newer context. Recent Pi history is the most important source for continuation, so truncation must preserve the tail of the reusable history rather than blindly taking the first bytes of the reduced log projection.

### Retained User Messages

Retained user messages are selected newest-first until the retained-message token budget is exhausted, then restored to chronological order. If the newest eligible user message exceeds the remaining budget, Junior may truncate the text to fit rather than dropping all recent user wording.

Eligible retained messages must be user-authored semantic input. They must not include:

- synthetic runtime context blocks
- compaction handoff summaries
- non-text image bytes or attachment base64
- tool results
- assistant messages

### Compaction Projection Events

Compaction persists replacement history by appending one projection event to the same conversation log.

Compaction must not destructively rewrite previous log entries. Keeping the pre-compaction entries available preserves auditability and avoids corrupting any recovery path.

Compaction projection events must use a deterministic event id derived from the source log position or an explicit idempotency key. Retried automatic compaction must not create an unbounded chain of duplicate projection events for the same source position.

### Automatic Pre-Turn Compaction

Automatic pre-turn compaction may replace an oversized reusable conversation-log projection before the next agent turn starts. It must:

1. Run after reusable Pi history is loaded.
2. Finish before `executeAgentRun(...)` receives `piMessages`.
3. Use the compacted replacement history for the upcoming turn.
4. Append the compaction projection before final thread-state persistence for the turn.
5. Start explicit assistant progress after the threshold decision and before summarization when a status surface is available, then return to the normal turn status before agent execution.

Automatic compaction must not post Slack thread messages by itself. Assistant status and final reply delivery remain owned by the Slack runtime.

### Visible Conversation-State Compaction

Slack conversation-state compaction must keep routing and no-Pi-history background bounded. It may retain bounded chunk summaries plus recent visible messages, but it must prune or merge older summaries rather than accumulating an unbounded XML log.

Visible conversation-state compaction must preserve image analysis summaries and message metadata needed for later explicit mentions to reason about earlier attachments.

### Token Accounting

Automatic Pi-history compaction must derive its threshold from the active agent model's advertised context window. Visible Slack conversation-state compaction must use the same budget rule against the auxiliary model because routing and summary calls use that model family. Junior reserves output headroom, then triggers when estimated reusable history exceeds the configured share of the remaining input budget.

Pi model metadata is the default source of `contextWindow` and `maxTokens`. `AI_MODEL_CONTEXT_WINDOW_TOKENS` may override the active agent model's advertised context window when provider metadata is missing, stale, or intentionally constrained for operations. The auxiliary model context window must come from model metadata.

Compaction triggers should prefer server-reported input-token counts for the most recent or largest single model call when available. Character-based estimates are allowed only as a fallback.

Cumulative turn token usage must not be the only trigger input because multi-step/tool-heavy turns can sum multiple model calls and overstate the next prompt size.

### Initial Context

Pre-turn compaction does not store current runtime context in compacted history. The next turn reinjects base instructions and volatile runtime context through the normal prompt path.

If Junior later adds mid-turn compaction, that path must define a separate insertion rule for current runtime context before the last real user message and must prove Pi `continue()` still resumes correctly.

## Failure Model

1. If summarization fails during automatic pre-turn compaction, Junior must continue with the prior reusable history unless the model provider has already rejected the prompt as too large.
2. If replacement projection persistence fails, Junior must continue with the prior reduced log.
3. If compaction is requested while the conversation log has an awaiting resume pause, Junior must refuse or defer compaction rather than compacting the resumable projection.
4. If retained-message selection cannot parse a message shape, Junior must omit that message from retained verbatim history and rely on the handoff summary.

## Observability

Compaction events should emit structured attributes when available:

- `app.compaction.input_messages`
- `app.compaction.retained_messages`
- `app.compaction.summary_chars`
- `app.compaction.source_event_id`
- `app.compaction.projection_event_id`
- `app.compaction.trigger_tokens`
- `app.compaction.target_tokens`
- `app.context_tokens_estimated`
- `gen_ai.request.model`
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`

Logs and spans must not include raw OAuth tokens, provider credentials, raw private file bytes, raw image base64, or unredacted secret-bearing tool output.

Compaction model calls may send selected history to the model provider, but tracing for those calls must capture message metadata rather than raw prompt or summary text. Model id, duration, finish reason, and token usage remain observable.

## Verification

1. Unit: retained-message selection keeps newest eligible user messages within budget and preserves chronological order.
2. Unit: replacement history excludes runtime context, assistant messages, tool results, image/base64 payloads, and existing compaction summaries.
3. Unit: automatic compaction appends one projection event and does not rewrite prior log entries.
4. Integration: a long Slack thread with reusable Pi history uses compacted Pi history on the next turn.
5. Integration: compaction is skipped or rejected while an awaiting timeout/auth resume pause is active.
6. Eval: long-thread continuity after compaction when the expected outcome depends on model interpretation.

## Related Specs

- `./chat-architecture.md`
- `./agent-session-resumability.md`
- `./agent-prompt.md`
- `./slack-agent-delivery.md`
- `./testing.md`
