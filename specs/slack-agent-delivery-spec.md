# Slack Agent Delivery Spec

## Metadata

- Created: 2026-04-15
- Last Edited: 2026-04-16

## Changelog

- 2026-04-15: Initial canonical contract for Slack agent entry surfaces, reply delivery, continuation behavior, and convergence plan.
- 2026-04-16: Removed streamed Slack text from the primary delivery contract. Standardized on assistant status for in-flight progress plus finalized thread replies for visible output.
- 2026-04-16: Clarified that reply-text translation is owned by the shared Slack output module and direct outbound callers only deliver already-rendered Slack text.
- 2026-04-16: Clarified that Chat SDK Slack `thread.channelId` values are adapter-scoped (`slack:<channel>`) and must be normalized before assistant status/title API calls.
- 2026-04-16: Corrected the assistant-thread context rule to match Slack assistant utilities: `message.im` uses `channel + thread_ts`, lifecycle events use `assistant_thread.channel_id + assistant_thread.thread_ts`, and runtime code does not synthesize a fallback from generic message `ts`.

## Status

Active

## Purpose

Define the canonical user-visible Slack agent delivery contract for Junior:

- which Slack surfaces start or continue work
- how Junior builds and delivers replies in threads
- how assistant status, continuation posts, files, images, and resumed turns behave
- which Slack APIs are part of the product contract versus optional transport details

This spec exists so Slack behavior is described in one place instead of being inferred from runtime code, resume handlers, and tests independently.

## Scope

- DM, channel mention, subscribed-thread, and assistant-thread entry surfaces
- Thread context sourcing and image-hydration expectations relevant to delivery
- Long-running Slack UX: assistant status, finalized replies, continuation posts, files
- Resume and OAuth callback delivery behavior for paused Slack turns
- Verification shape for behavior tests versus Slack transport-contract tests

## Non-Goals

- Replacing the chat architecture contract in `chat-architecture-spec.md`
- Re-specifying OAuth token security or MCP credential handling
- Defining conversational quality criteria that belong to evals
- Making Slack-native text streaming part of Junior's correctness contract

## Contracts

### 1. Entry Surfaces

Junior currently supports four Slack entry paths:

1. Direct messages route through the explicit-mention path and must always be treated as reply-eligible.
2. Channel or thread `@mentions` route through the explicit-mention path.
3. Subscribed-thread follow-ups route through the subscribed-message path and may reply or stay silent based on the subscribed-thread policy.
4. Slack assistant lifecycle events (`assistant_thread_started`, `assistant_thread_context_changed`) initialize or refresh assistant-thread metadata and context.

Implications:

- DM traffic must not be silently treated like passive subscribed-thread traffic.
- Explicit mentions bypass passive no-reply classification.
- Assistant-thread lifecycle handling is part of the production surface even when the main conversational UX still happens in normal threads.

### 2. Context Sourcing Contract

Junior must prefer persisted local thread state over refetching Slack thread history on every turn.

Current contract:

1. Seed thread conversation state once from the available thread history (`thread.messages` or recent thread messages) when local conversation state is empty.
2. Persist normalized user and assistant messages into thread conversation state as the canonical ongoing context.
3. Rebuild per-turn prompt context from persisted conversation state, not from ad-hoc Slack history fetches.
4. Preserve attachment/image context across ingress and skipped-thread paths so later turns can still reason about earlier screenshots or uploaded images.
5. For Slack assistant status/title updates, Junior must use Slack's live assistant-thread identifiers from the current event: `message.im` uses `channel` + explicit `thread_ts`, while lifecycle events use `assistant_thread.channel_id` + `assistant_thread.thread_ts`. Junior must not synthesize assistant-thread roots from persisted state or generic message `ts`.

This contract is intentional because Slack thread-history fetches are not a stable per-turn dependency for modern agent behavior, especially given Slack's newer `conversations.replies` limits for some app classes.

### 3. Assistant-Thread Lifecycle Contract

When Slack starts an assistant thread, Junior must:

1. Set an assistant thread title.
2. Set suggested prompts.
3. Persist assistant-context channel information when Slack provides source-channel context.
4. Normalize Chat SDK Slack channel identifiers before calling Slack assistant-thread APIs. `thread.channelId` is adapter-scoped (`slack:<channel>`), while Slack's `assistant.threads.*` methods require the raw conversation ID (`C...` / `D...`).
5. `assistant_thread_context_changed` refreshes assistant context and prompts, but it must not reset an already established conversation title back to a generic default.
6. When Junior updates a DM/app-thread title to something conversation-specific, it must generate that title from the earliest human message Junior actually knows about for the thread, using the lightweight title model. Do not derive the title from a later follow-up or from assistant reply text.
7. Title generation may run in parallel with the main assistant turn, but it must not delay assistant reply generation or visible reply delivery.

This lifecycle path currently enriches the assistant container but does not replace the main thread-based reply contract.

### 4. Long-Running Status Contract

Junior must surface progress during long-running turns before final reply delivery.

Current contract:

1. Start a non-empty assistant status early in the turn.
2. Debounce rapid status changes.
3. Refresh non-empty status before Slack clears it automatically.
4. Clear the status explicitly when the turn stops.
5. Treat status updates as best effort. Status-update failures are observable but do not by themselves fail the turn.
6. Normalize Chat SDK Slack channel identifiers before `assistant.threads.setStatus`. Runtime code must not pass adapter-scoped `slack:<channel>` values through to Slack.
7. Slack `assistant.threads.*` calls must use the current inbound event's live assistant-thread key. For `message.im`, an explicit `thread_ts` is required; when Slack omits it, Junior skips assistant status/title updates instead of substituting the message `ts` or a stored root.
8. Status transports that debounce, rotate, or otherwise defer updates must bind the active Slack bot token when the turn starts instead of relying on later ambient request context. Delayed status updates must keep targeting the same workspace installation as the turn's final reply.
9. Assistant status is best effort and must not sit on the critical path for model/tool execution. Starting a turn or updating mid-turn status may queue Slack writes, but must not wait for Slack round-trips before assistant work continues.

Status is the only in-flight progress surface required by the contract. Visible assistant reply text is posted only after the turn result is finalized and delivery has been planned.

### 5. Primary Reply Contract

Junior has one primary visible reply surface per turn: finalized Slack thread replies.

Current rules:

1. Do not create a visible Slack text artifact until the assistant reply is final enough to budget, normalize, and persist.
2. Deliver visible reply text through finalized thread posts, not through incremental text streaming.
3. Only mark a turn successful after the final visible Slack reply has been accepted by Slack.
4. If explicit user intent requested an in-channel post and that post already satisfied the request, Junior may suppress the thread text reply according to the reply-delivery plan.
5. Persisted assistant conversation state must reflect the same finalized reply content the user saw, not provisional pre-tool text.
6. Reply text must be rendered through the shared Slack output translator before delivery; raw Slack API writers do not own markdown translation rules.

This is intentional. Slack-native text streaming may still exist as an adapter capability, but it is not part of Junior's correctness contract.

### 6. Continuation Contract

Slack continuation posts are part of the user-visible delivery contract.

Current rules:

1. A single inline Slack reply is capped by the repository reply budget (`2200` chars, `45` lines).
2. If a finalized reply exceeds that budget, Junior splits it into multiple thread messages.
3. Every non-final overflow chunk ends with `[Continued below]`.
4. The final chunk does not carry `[Continued below]`.
5. If a visible reply ended because the provider failed mid-turn, the final visible chunk ends with `[Response interrupted before completion]`.
6. Continuation markers are delivery-time formatting, not model-authored text.

### 7. Code Fence Continuation Contract

Continuation behavior must preserve readable fenced markdown/code in Slack.

Current rules:

1. If a chunk boundary lands inside an open fenced code block, Junior closes the fence before appending `[Continued below]`.
2. The next chunk reopens the fence before continuing the remaining content.

This is required for readable Slack rendering, not an optional formatting nicety.

### 8. File Delivery Contract

Files are part of the same finalized reply-delivery plan as text.

Current rules:

1. Thread replies attach files inline on the first visible reply post when possible.
2. File-only replies must still create a visible Slack thread reply carrying the file payload.
3. If thread text is intentionally suppressed, files may still be delivered through the thread reply planner when the reply contract requires visible artifacts.
4. Resume and OAuth callback flows must use the same file-delivery semantics as the main runtime path.

### 9. Image Ingress Contract

Images passed into Slack threads are part of the thread context contract.

Current rules:

1. Slack file/image attachments on inbound messages must survive ingress normalization, including `message_changed` events.
2. Private-file fetchers must be rehydrated before runtime processing whenever messages are deserialized or side-channeled through webhook handlers.
3. Passive subscribed-thread messages that include potential image attachments must not be permanently marked as already hydrated before image hydration has actually run.
4. Later explicit mentions in the same thread may rely on previously skipped screenshots or image uploads still being recoverable from persisted conversation state.

### 10. Resume Delivery Contract

Paused turns resumed by timeout or OAuth must follow the same final Slack delivery contract as live turns.

Current rules:

1. Resume handlers generate the final reply under the normal thread lock.
2. Resume handlers use the shared Slack reply planner for text chunking, continuation markers, interruption markers, and file delivery.
3. Resume success is defined by final visible Slack delivery, not only by successful assistant generation.
4. Persisted thread state is updated only after the final reply has been delivered to Slack.
5. Because live turns do not publish provisional assistant text, timeout continuation remains eligible until final reply delivery starts.

### 11. Testing Contract

Slack integration coverage must be behavior-first while still protecting real Slack transport contracts.

Required split:

1. Behavior integration tests cover scenario-readable runtime outcomes.
2. Slack transport-contract integration tests cover request shape, recipient metadata, and other external Slack API details when those details are the contract.
3. Transport-contract assertions must live in dedicated contract-oriented tests or clearly named suites, not dominate general behavior test files.
4. Evals cover conversational outcomes and realistic prompts, not low-level Slack request mechanics.

## Failure Model

1. Slack status-update failures are best effort and must not by themselves fail the turn.
2. Slack thread-post or final delivery failures are turn failures because the visible reply contract was not satisfied.
3. Junior must not persist assistant conversation state for a turn until final Slack delivery succeeds.
4. If a reply normalizes to empty and no files exist, Junior must post an explicit fallback message rather than silently succeeding.
5. If a chunked reply overflows a code fence boundary, fence integrity must still be preserved in the delivered Slack posts.

## Observability

Slack delivery behavior must emit enough diagnostics to distinguish:

- reply planning from post failure
- best-effort status failures from reply failures
- skipped subscribed-thread replies from delivery bugs
- resume delivery failures from generation failures

Representative event names already in use include:

- `slack_thread_post_failed`
- `assistant_status_update_failed`
- `subscribed_message_reply_skipped`
- `timeout_resume_failed`

Required attribute families remain governed by the logging specs, especially messaging/thread identifiers and AI turn/session context.

## Verification

Required verification coverage for this contract:

1. Integration: DM, mention, and subscribed-thread routing outcomes.
2. Integration: long-running status plus finalized primary reply behavior.
3. Integration: continuation overflow, interruption markers, and code-fence preservation.
4. Integration: file-only replies, suppressed-thread-text file delivery, and resume-path file parity.
5. Integration: image attachments surviving edited-message ingress and skipped passive-thread hydration.
6. Integration: assistant-thread lifecycle metadata initialization.
7. Evals: realistic user-visible multi-turn Slack behaviors when model interpretation is part of the contract.

## Convergence Plan

This section is non-normative. It describes the intended cleanup sequence without changing the current contract above.

### Phase 1: Lock the Finalized-Reply Contract

1. Keep the shared Slack reply planner as the only authority for continuation markers, file delivery, and resumed post planning.
2. Keep persisted thread conversation state as the primary context source.
3. Keep the explicit separation between behavior integration tests and Slack transport-contract tests.

Exit criteria:

- No alternate resume-only or ingress-only reply formatting path remains.
- Canonical specs and behavior tests describe the same continuation/file semantics.

### Phase 2: Improve Progress Without Reintroducing Text Streaming Coupling

1. Keep assistant status as the baseline progress affordance.
2. If richer progress is needed later, prefer status/task-oriented surfaces over provisional assistant prose.
3. Keep visible answer text tied to finalized reply delivery, not mid-generation transport state.

Exit criteria:

- Assistant-thread and long-running channel-thread experiences both surface observable progress without requiring provisional thread text.

### Phase 3: Keep Adapter Dependencies on the Public Surface

1. Prefer documented adapter and Slack API surfaces over monkey-patching private adapter internals.
2. Keep reply correctness independent from optional adapter-level streaming behavior.

Exit criteria:

- A Slack adapter upgrade failure is caught at a narrow boundary instead of breaking reply delivery deep in production flow.

## Related Specs

- `./chat-architecture-spec.md`
- `./slack-outbound-contract-spec.md`
- `./oauth-flows-spec.md`
- `./agent-session-resumability-spec.md`
- `./testing/index.md`
