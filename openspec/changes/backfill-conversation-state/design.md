## Context

`ThreadConversationState` is Junior's durable visible Slack-thread memory. It stores normalized visible messages, message metadata, compacted visible summaries, backfill state, processing pointers, context stats, and image-analysis summaries. This state feeds routing context, prompt background, title selection, and Slack-visible delivery state.

It is not the canonical Pi execution transcript. Durable Pi history belongs to the agent session log and turn-session projection described in `agent-session-resumability`. `conversation.piMessages` and active/last session pointers are transitional or routing read models, not a second durable model-history authority.

Current implementation:

- coerces unknown persisted state into a versioned default state
- upserts inbound/queued Slack messages with author, text, attachment/image, mention, reply, skip, and Slack timestamp metadata
- backfills existing thread messages from `thread.messages` or `thread.recentMessages`
- builds XML-ish thread context for prompts/routing
- compacts older visible messages into bounded summary records
- stores image summaries by Slack file id and renders them alongside relevant message lines
- tracks processing pointers such as `activeTurnId`, `lastSessionId`, and thread-local `pendingAuth`

## Goals / Non-Goals

**Goals:**

- Specify visible conversation-state shape and ownership.
- Preserve the separation between Slack-visible transcript memory and Pi/session history.
- Specify message upsert, backfill, context rendering, visible compaction, image-summary references, and processing pointers.
- Record target/current gaps such as legacy `piMessages` in conversation state and undefined retention/TTL.
- Keep verification taxonomy separate from agent/prompt/model evals.

**Non-Goals:**

- Replacing the agent session log or turn-session records.
- Specifying Slack outbound formatting or final delivery transport.
- Specifying image analysis implementation details beyond state references.
- Freezing exact XML context text.
- Defining persistent storage backend details.

## Decisions

### Decision: Visible conversation state is prompt/routing memory, not Pi history

The state may point at active or last reusable sessions, but the model execution transcript belongs to session history. Prompt context built from visible conversation state is background for Slack thread continuity, not a replacement for Pi replay.

Alternatives considered:

- Store all Pi messages in conversation state: rejected because it duplicates session-log authority and risks stale replay.
- Drop visible transcript state and rely only on Pi history: rejected because routing, title generation, skipped passive messages, and visible attachment/image summaries need Slack-visible memory.

### Decision: Preserve skipped and replied metadata as part of visible context

Skipped passive messages and reply markers help future turns interpret what happened in the thread. They should be persisted as message metadata rather than hidden logs.

Alternatives considered:

- Omit skipped messages: rejected because later explicit mentions may ask about them.
- Store only raw Slack messages: rejected because routing and prompt context need normalized metadata.

### Decision: Keep visible compaction bounded and separate from Pi compaction

Visible conversation compaction summarizes old Slack-visible messages for routing/prompt background. Reusable Pi-history compaction is a different capability and must not be conflated with visible transcript summaries.

Alternatives considered:

- Use one compaction mechanism for both surfaces: rejected because they have different consumers and safety constraints.
- Accumulate every compaction forever: rejected because visible context would become unbounded.

## Risks / Trade-offs

- [Risk] Conversation state becomes a second session log. Mitigation: requirements state that Pi history is not owned here.
- [Risk] Retention/TTL remains implicit. Mitigation: mark retention policy as open until storage policy is accepted.
- [Risk] Image summary ownership overlaps attachment/vision specs. Mitigation: this spec owns storage/rendering references; attachment-and-vision owns extraction/analysis.
- [Risk] Exact context text becomes brittle. Mitigation: requirements specify structure and semantics, not exact prose.

## Open Questions

- Should `conversation.piMessages` be removed once session-log projection is fully authoritative?
- What TTL or retention window applies to persisted visible conversation state?
- Should visible conversation compaction implementation details live here or in `context-compaction` with this spec only owning the state shape?
- Which fields in `processing` are permanent visible-thread state versus transitional callback/session read models?
- Should malformed persisted state be repaired silently, dropped, or surfaced operationally?

## Migration Plan

1. Validate this OpenSpec change.
2. Review target/current gaps against chat architecture and session resumability specs.
3. After acceptance, archive this capability into `openspec/specs/conversation-state/spec.md`.
4. Plan follow-up cleanup for legacy `conversation.piMessages` if the session-log migration makes it redundant.
5. Use the verification map to split tests currently mixed into broader Slack behavior files.
