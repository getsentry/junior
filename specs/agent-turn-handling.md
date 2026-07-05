# Agent Turn Handling Spec

## Metadata

- Created: 2026-05-30
- Last Edited: 2026-07-02

## Purpose

Define how Junior responds to user-authored messages at the agent-policy level: when it should answer, stay silent, ask, use tools, satisfy Slack side-effect requests, continue resumed work, and consider a turn complete.

This spec fills the gap between Slack delivery mechanics, prompt wording, and Pi execution internals. It describes observable turn behavior without freezing exact prompt prose or Slack transport details.

## Scope

- Active request surfaces: DMs, explicit mentions, and user-authored Slack assistant/app-thread messages.
- Passive subscribed-thread participation and no-reply behavior.
- Queued/skipped user input handling at the turn-policy level.
- In-turn execution, clarification, source use, and thread continuity.
- Slack side-effect intent and duplicate-reply suppression at the policy level.
- Progress/resumed-turn final-answer expectations.
- Attachment and unavailable-vision expectations that affect turn response.
- Turn completion outcomes.

## Non-Goals

- Slack API formatting, chunking, file upload, status transport, or final delivery mechanics. See `./slack-agent-delivery.md` and `./slack-outbound-contract.md`.
- Pi loop mechanics, terminal assistant output assembly, and diagnostics. See `./harness-agent.md`.
- Durable session record schema and continuation callback safety. See `./agent-session-resumability.md`.
- Exact prompt text. See `./agent-prompt.md`.
- Context-bound tool target enforcement. See `./harness-tool-context.md`.
- Test-layer taxonomy. See `./testing.md`.

## Contracts

### 1. Active User Requests

Junior must treat direct messages, explicit mentions, and Slack assistant/app-thread user-message events as active requests that are eligible for a reply without passive subscribed-thread classification.

Slack assistant lifecycle events are setup/context events, not user-message turns.

Scenarios:

1. Direct message asks for help:
   - When a user sends Junior a direct message asking for work or information, Junior must handle the message as an active turn and produce a final user-facing answer unless the turn pauses, fails, or is genuinely blocked.
2. Channel mention asks Junior to act:
   - When a user mentions Junior in a channel or thread and gives an instruction, Junior must bypass passive no-reply routing, subscribe to the thread when applicable, and handle the message as an active turn.
3. Assistant lifecycle event initializes context:
   - When Slack sends an assistant-thread lifecycle event without a user-authored message, Junior must initialize or refresh assistant-thread metadata without running a normal assistant answer.
4. Explicit mention contains stop instruction:
   - When a user explicitly tells Junior to stop watching, replying, or participating in a subscribed thread, Junior must unsubscribe from the thread, acknowledge the opt-out, and not run a normal assistant answer for that message.

### 2. Passive Subscribed-Thread Participation

Junior must treat subscribed Slack threads as passive by default and reply only when the latest user message is directed back to Junior. Attachments are routing context and answer context, not an automatic reason to reply.

Scenarios:

1. Human side conversation:
   - When a subscribed thread receives a user message addressed to another person or continuing human-to-human coordination, Junior must skip the reply and persist enough message context for future turns.
2. Acknowledgement only:
   - When a subscribed thread receives a message such as "thanks", "got it", "sounds good", or equivalent acknowledgement without an explicit ask, Junior must skip the reply.
3. Immediate terse clarification:
   - When Junior was the last speaker and the next user message is a terse clarification such as "why?", "which one?", or "say more", Junior must treat the message as an implicit follow-up and answer in the thread.
4. Low-confidence passive routing:
   - When subscribed-thread routing cannot confidently determine that the latest message is for Junior, Junior must prefer staying silent over interrupting the thread.
5. Attachment-only passive message:
   - When a subscribed thread receives an attachment-only or attachment-backed message without an explicit mention, Junior must route the message with attachment context and must not reply solely because an attachment exists.

### 3. Self-Message Loop Prevention

Junior must avoid responding to messages authored by itself so Slack delivery, retries, and bot-authored follow-ups do not create reply loops.

Scenarios:

1. Junior-authored message is observed:
   - When Junior observes a message whose author is Junior itself, Junior must not start a normal assistant turn for that message.
2. Bot-authored passive message:
   - When a subscribed thread receives a message authored by another bot and no human directed Junior to act, Junior must not reply. Bot-authored passive traffic fails closed to silence so two bots cannot enter a reply loop.

### 4. Queued And Skipped User Input

Junior must preserve user-authored messages that arrive while a turn is active or parked and make them model-visible in the same conversation according to the mailbox contract in `./task-execution.md`.

Scenarios:

1. Multiple messages arrive during an active turn:
   - When users send one or more messages while an earlier message is still being processed, Junior must combine the queued user text with the dispatched message text for the next eligible turn.
2. Skipped passive message later becomes relevant:
   - When Junior skips a passive subscribed-thread message and a later explicit mention asks about the same thread context, Junior must make the skipped message available as prior conversation context when building the later turn.
3. Message arrives while a turn awaits continuation:
   - When a user message arrives while the conversation is parked awaiting a timeout, yield, or auth continuation, Junior must make the message model-visible — steered into the resumed run or handled as the next turn — and answer or acknowledge it. Consuming the message without model visibility is a contract violation.

### 5. In-Turn Execution Policy

Junior must satisfy actionable requests in the current turn by using available context, skills, and tools before asking the user for help or ending with a plan.

Scenarios:

1. Actionable request has available tools:
   - When the user asks Junior to inspect, change, verify, search, post, react, or otherwise act and the required tool or source is available, Junior must use the tool or source in the same turn and answer with the result.
2. Missing access or required decision:
   - When Junior cannot safely continue because required access, approval, or a user decision is missing, Junior must ask one focused clarifying or approval question instead of guessing.
3. Mutable or current fact:
   - When the user asks about a mutable fact, current state, repository contents, provider state, or a user-provided source, Junior must verify against the nearest authoritative available source before answering.

### 6. Thread Continuity And Role Attribution

Junior must interpret the latest user message in the context of the Slack thread while preserving who is asking now versus who authored prior context.

Scenarios:

1. Follow-up references prior answer:
   - When the user asks a follow-up that depends on Junior's prior thread answer, Junior must answer from prior thread context without repeating already resolved clarifying questions.
2. Requester differs from original reporter:
   - When a different user asks a follow-up in the same Slack thread, Junior must treat the current user as the requester while preserving attribution for earlier messages and subjects.

### 7. Slack Side-Effect Intent

Junior must use Slack side-effect tools only when the user explicitly requests the side effect, and must not claim success unless the tool succeeded in the current turn.

Scenarios:

1. User asks Junior to send content in thread:
   - When Junior needs to send, share, or attach text, sandbox-path files, or both here, in this conversation, or in the current Slack thread, Junior may use `sendMessage`.
   - `sendMessage` has no model-supplied target. Runtime source context owns the active Slack conversation/thread.
   - `sendMessage` is a Slack side effect, not the final assistant reply. Junior may still provide normal final assistant text afterward when useful.
2. User asks Junior to post in channel:
   - Top-level channel posting is not currently a model-facing Slack side-effect capability. Junior must explain that it can send only into the active conversation instead of pretending a thread reply is a top-level channel post.
3. User asks Junior to react:
   - When the user explicitly asks Junior to add a Slack reaction, Junior must use `addReaction` when the runtime provides a valid target and must not treat automatic processing reactions as satisfying the user's request.
4. Slack side effect satisfies the turn:
   - When a successful Slack side-effect tool already satisfies the user's request, Junior may suppress a duplicate final thread reply according to the reply-delivery plan when the assistant used the no-reply marker.
   - `sendMessage` does not by itself satisfy the final assistant reply contract.

### 8. Progress And Resumed-Turn Behavior

Junior must keep long-running Slack turns visibly alive through runtime-owned progress surfaces and avoid duplicating runtime continuation or authorization notices in model-authored final replies.

Scenarios:

1. Non-trivial long-running work:
   - When a turn requires non-trivial multi-step work, Junior must emit progress through the runtime progress mechanism when available and reserve final answer text for the completed result.
2. Authorization pause resumes:
   - When a turn resumes after an authorization pause, Junior must continue the pending user request from durable session history and answer with the final requested content only.
3. Timeout continuation resumes:
   - When a turn resumes after a timeout continuation, Junior must continue the same pending turn and not apologize for or mention routine runtime continuation unless the final answer needs to explain an actual blocker.

### 9. Attachments And Unavailable Vision

Junior must treat Slack attachments as part of the user turn and distinguish unavailable analysis capability from absent attachments.

Scenarios:

1. Text or file attachment included:
   - When a Slack message includes text, files, or attachment metadata that can be converted into prompt context, Junior must use that attachment context when deciding and answering the turn.
2. Image analysis unavailable:
   - When Slack delivered image attachments but the configured runtime cannot analyze images, Junior must say image analysis is unavailable if the image contents are relevant, and must not claim that no image was attached.

### 10. Turn Completion

Junior must consider a user turn complete only when the user's actual request has a final outcome: answered, satisfied by a successful side effect, paused for runtime-owned continuation/auth, explicitly blocked, or failed with an actionable fallback.

Scenarios:

1. Normal answer:
   - When Junior completes model/tool execution and final Slack delivery accepts the visible reply, Junior must mark the turn as completed and persist the assistant message as visible conversation state.
2. Tool or provider failure:
   - When a tool, provider, or runtime failure prevents the requested work from completing, Junior must either recover within the turn, pause through the appropriate runtime mechanism, or provide an explicit user-visible failure response.
3. Final answer cannot be empty:
   - When a turn does not produce a successful side effect, file-only reply, pause notice, or non-empty assistant answer, Junior must deliver an explicit fallback response rather than silently completing the turn.

## Failure Model

1. Passive routing uncertainty must fail closed to silence in subscribed threads.
2. Active request failures must produce a visible answer, runtime-owned pause notice, or fallback failure response.
3. Junior-authored messages must not start recursive turns.
4. Slack side effects must not be reported as successful unless the tool succeeded in the same turn.
5. Empty model output is not a successful final answer unless a successful side effect, file-only reply, or runtime-owned pause already satisfied the turn.
6. User-visible failure text is the sanitized fallback response with its correlation/event id. Raw exception messages, stack traces, and internal error strings must not be delivered as reply text. Partial output may be delivered only when it is genuine model-authored text.
7. Repeated failures for the same inbound message are bounded by the dead-letter contract in `./task-execution.md`; one inbound message produces at most one visible failure reply.

## Observability

Turn handling must be diagnosable through existing turn, routing, and delivery events. Relevant event families include:

- subscribed-message skipped decisions
- agent turn started/completed/failed
- auth and timeout pause/resume events
- Slack final delivery failures
- tool invocation diagnostics

This spec does not require new event names by itself. Attribute naming remains governed by `./instrumentation.md`, `./logging.md`, `./tracing.md`, and `./otel-semantics.md`.

## Verification

- Deterministic routing and local policy checks belong in unit tests.
- Runtime wiring, Slack-visible behavior, final delivery, continuation, persistence, and side-effect suppression belong in integration tests.
- Natural-language participation, source use, ask-only-when-blocked behavior, thread continuity, and model tool-choice quality belong in evals.
- Existing eval names are coverage inventory, not the required taxonomy. Map eval cases to capability requirements before renaming or splitting files.

Representative current coverage includes:

- `packages/junior/tests/unit/slack/chat-ingress-bindings.test.ts`
- `packages/junior/tests/unit/slack/slack-runtime.test.ts`
- `packages/junior/tests/unit/routing/subscribed-decision.test.ts`
- `packages/junior/tests/unit/turn-result.test.ts`
- `packages/junior/tests/integration/slack/new-mention-behavior.test.ts`
- `packages/junior/tests/integration/slack/subscribed-message-behavior.test.ts`
- `packages/junior/tests/integration/slack/bot-handlers.test.ts`
- `packages/junior/tests/integration/agent-continue-slack.test.ts`
- `packages/junior-evals/evals/core/passive-behavior.eval.ts`
- `packages/junior-evals/evals/core/routing-and-continuity.eval.ts`

## Related Specs

- `./chat-architecture.md`
- `./slack-agent-delivery.md`
- `./slack-outbound-contract.md`
- `./agent-session-resumability.md`
- `./agent-prompt.md`
- `./harness-agent.md`
- `./harness-tool-context.md`
- `./testing.md`
