# Slack Agent Delivery Spec

## Metadata

- Created: 2026-04-15
- Last Edited: 2026-04-15

## Changelog

- 2026-04-15: Initial canonical contract for Slack agent entry surfaces, reply delivery, continuation behavior, and convergence plan.

## Status

Active

## Purpose

Define the canonical user-visible Slack agent delivery contract for Junior:

- which Slack surfaces start or continue work
- how Junior builds and delivers replies in threads
- how streaming, overflow, files, images, and resumed turns behave
- which parts of the current Slack interface are intentional versus transitional

This spec exists so Slack behavior is described in one place instead of being inferred from runtime code, resume handlers, and tests independently.

## Scope

- DM, channel mention, subscribed-thread, and assistant-thread entry surfaces
- Thread context sourcing and image-hydration expectations relevant to delivery
- Long-running Slack UX: assistant status, streamed text, continuation posts, files
- Resume and OAuth callback delivery behavior for paused Slack turns
- Verification shape for behavior tests versus Slack transport-contract tests

## Non-Goals

- Replacing the chat architecture contract in `chat-architecture-spec.md`
- Re-specifying OAuth token security or MCP credential handling
- Defining conversational quality criteria that belong to evals
- Locking Junior to the current adapter monkey-patch implementation forever

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

This contract is intentional because Slack thread-history fetches are not a stable per-turn dependency for modern agent behavior, especially given Slack rate limits on `conversations.replies` for some app classes.

### 3. Assistant-Thread Lifecycle Contract

When Slack starts an assistant thread, Junior must:

1. Set an assistant thread title.
2. Set suggested prompts.
3. Persist assistant-context channel information when Slack provides source-channel context.

This lifecycle path currently enriches the assistant container but does not replace the main thread-based reply contract.

### 4. Long-Running Status Contract

Junior must surface progress during long-running turns before final reply delivery.

Current contract:

1. Start a non-empty assistant status early in the turn.
2. Debounce rapid status changes.
3. Refresh non-empty status before Slack clears it automatically.
4. Clear the status explicitly when the turn stops.
5. Treat status updates as best effort. Status-update failures are observable but do not by themselves fail the turn.

Status is a progress affordance, not the primary answer channel.

### 5. Primary Reply Contract

Junior has one primary visible reply surface per turn: the Slack thread reply.

Current rules:

1. Prefer native Chat SDK streaming by passing `AsyncIterable<string>` to `thread.post(...)`.
2. Use the Slack adapter’s native streaming API path (`chat.startStream` / `chat.appendStream` / `chat.stopStream`) instead of bespoke `chat.update` loops.
3. Only mark a turn successful after the final visible Slack reply has been accepted by Slack.
4. The current runtime streams markdown text only; structured task/plan stream chunks are not yet part of the delivery contract.
5. If explicit user intent requested an in-channel post and that post already satisfied the request, Junior may suppress the thread text reply or reduce it to a minimal acknowledgment according to the reply-delivery plan.

### 6. Stream-Start and Ack Contract

Junior may delay stream start while the visible text still looks like a redundant short acknowledgment.

Current behavior:

1. Buffer early deltas while they still look like an emoji-only or short `ok` / `done` acknowledgment.
2. If the reply remains a short acknowledgment, keep delivery on the normal non-streamed post path.
3. Once visible content exceeds that narrow acknowledgment shape, start the streamed thread reply.

This exists to avoid noisy streamed acknowledgments for turns where a reaction or minimal text already covers the intent.

### 7. Continuation Contract

Slack continuation posts are part of the user-visible delivery contract.

Current rules:

1. A single inline Slack reply is capped by the repository reply budget (`2200` chars, `45` lines).
2. If a non-streamed reply exceeds that budget, Junior splits it into multiple thread messages.
3. Every non-final overflow chunk ends with `[Continued below]`.
4. The final chunk does not carry `[Continued below]`.
5. If a visible reply ended because the provider failed mid-turn, the final visible chunk ends with `[Response interrupted before completion]`.
6. Continuation markers are delivery-time formatting, not model-authored text.

### 8. Code Fence Continuation Contract

Continuation behavior must preserve readable fenced markdown/code in Slack.

Current rules:

1. If a chunk boundary lands inside an open fenced code block, Junior closes the fence before appending `[Continued below]`.
2. The next chunk reopens the fence before continuing the remaining content.
3. The same rule applies to streamed overflow and non-streamed overflow.

This is required for readable Slack rendering, not an optional formatting nicety.

### 9. File Delivery Contract

Files are part of the same reply-delivery plan as text.

Current rules:

1. Non-streamed thread replies may attach files inline on the first thread post.
2. File-only non-streamed replies must still create a visible Slack thread reply carrying the file payload.
3. Streamed replies must deliver files as follow-up posts after the streamed text reply is complete.
4. Resume and OAuth callback flows must use the same file-delivery semantics as the main runtime path.

### 10. Image Ingress Contract

Images passed into Slack threads are part of the thread context contract.

Current rules:

1. Slack file/image attachments on inbound messages must survive ingress normalization, including `message_changed` events.
2. Private-file fetchers must be rehydrated before runtime processing whenever messages are deserialized or side-channeled through webhook handlers.
3. Passive subscribed-thread messages that include potential image attachments must not be permanently marked as already hydrated before image hydration has actually run.
4. Later explicit mentions in the same thread may rely on previously skipped screenshots or image uploads still being recoverable from persisted conversation state.

### 11. Resume Delivery Contract

Paused turns resumed by timeout or OAuth must follow the same final Slack delivery contract as live turns.

Current rules:

1. Resume handlers generate the final reply under the normal thread lock.
2. Resume handlers use the shared Slack reply planner for text chunking, continuation markers, interruption markers, and file delivery.
3. Resume success is defined by final visible Slack delivery, not only by successful assistant generation.
4. Persisted thread state is updated only after the final reply has been delivered to Slack.

Related constraint from session resumability:

- If visible assistant output has already started, automatic timeout continuation must not attempt to resume and reconcile that partial user-visible output.

### 12. Testing Contract

Slack integration coverage must be behavior-first while still protecting real Slack transport contracts.

Required split:

1. Behavior integration tests cover scenario-readable runtime outcomes.
2. Slack transport-contract integration tests cover request shape, stream lifecycle, recipient metadata, and other external Slack API details when those details are the contract.
3. Transport-contract assertions must live in dedicated contract-oriented tests or clearly named suites, not dominate general behavior test files.
4. Evals cover conversational outcomes and realistic prompts, not low-level Slack request mechanics.

## Failure Model

1. Slack status-update failures are best effort and must not by themselves fail the turn.
2. Slack thread-post or final delivery failures are turn failures because the visible reply contract was not satisfied.
3. Once visible streamed output has started, Junior does not attempt to rewrite or reconcile partial output through automatic timeout resume.
4. If a reply normalizes to empty and no files exist, Junior must post an explicit fallback message rather than silently succeeding.
5. If a streamed or chunked reply overflows a code fence boundary, fence integrity must still be preserved in the delivered Slack posts.

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
2. Integration: long-running status plus streamed primary reply behavior.
3. Integration: continuation overflow, interruption markers, and code-fence preservation.
4. Integration: file-only replies, streamed file follow-ups, and resume-path file parity.
5. Integration: image attachments surviving edited-message ingress and skipped passive-thread hydration.
6. Integration: assistant-thread lifecycle metadata initialization.
7. Evals: realistic user-visible multi-turn Slack behaviors when model interpretation is part of the contract.

## Convergence Plan

This section is non-normative. It describes the intended cleanup sequence without changing the current contract above.

### Phase 1: Lock the Current Contract

1. Keep the shared Slack reply planner as the only authority for continuation markers, file delivery, and resumed post planning.
2. Keep persisted thread conversation state as the primary context source.
3. Keep the explicit separation between behavior integration tests and Slack transport-contract tests.

Exit criteria:

- No alternate resume-only or ingress-only reply formatting path remains.
- Canonical specs and behavior tests describe the same continuation/file semantics.

### Phase 2: Promote Agent-Native Progress

1. Keep assistant status as the low-friction baseline progress affordance.
2. Add runtime-owned structured streaming chunks for task updates and plan updates when Junior has semantic agent progress to show.
3. Treat streamed markdown text as the primary answer and structured chunks as progress state, not as a replacement for the final answer.

Exit criteria:

- Assistant-thread and long-running channel-thread experiences both surface observable progress beyond plain status text when meaningful progress exists.

### Phase 3: Reduce Adapter Fragility

1. Either upstream the required adapter streaming behavior or isolate the monkey patch behind a small compatibility shim with explicit version expectations.
2. Keep the runtime’s delivery contract independent from upstream private adapter internals as much as possible.

Exit criteria:

- A Slack adapter upgrade failure is caught by a narrow compatibility boundary instead of breaking reply delivery deep in production flow.

### Phase 4: Expand the Right Tests

1. Add a full assistant-thread long-running scenario that covers title/prompts, status, streaming, and completion.
2. Add behavior tests for resumed turns that include files and continuation chunks.
3. Add transport-contract coverage for structured stream chunks once runtime begins emitting them.
4. Keep behavior files scenario-readable and transport files explicitly contract-oriented.

Exit criteria:

- The main Slack agent UX is covered by scenario tests that read like real user flows.
- Low-level Slack transport assertions remain isolated to dedicated contract suites.

## Related Specs

- `./chat-architecture-spec.md`
- `./oauth-flows-spec.md`
- `./agent-session-resumability-spec.md`
- `./testing/index.md`
