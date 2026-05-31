# Backfill Worksheet: `conversation-state`

## Scope

- Capability: Conversation state
- Change: `backfill-conversation-state`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/conversation-state/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/chat-architecture.md`: data authority split between visible conversation transcript, active pause routing, and Pi session log.
- `specs/agent-session-resumability.md`: durable Pi execution history and auth/timeout session lifecycle.
- `specs/context-compaction.md`: visible conversation-state compaction bounds and separate Pi-history compaction.
- `specs/agent-prompt.md`: prompt context ownership and stale runtime context stripping.
- `specs/agent-turn-handling.md`: skipped/passive messages and thread continuity behavior.
- `specs/testing.md`: unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/state/conversation.ts`: schema, coercion, defaults, pending auth coercion, and state patch envelope.
- `packages/junior/src/chat/services/conversation-memory.ts`: message normalization/upsert/marking, context rendering, visible compaction, title source selection, stats.
- `packages/junior/src/chat/runtime/turn-preparation.ts`: thread-state load, backfill, queued-message persistence, current message persistence, vision hydration, compaction, context rendering.
- `packages/junior/src/chat/runtime/delivered-turn-state.ts`: final assistant visible-message persistence.
- `packages/junior/src/chat/runtime/auth-pause-state.ts`, `pending-auth.ts`, OAuth/MCP callbacks: pending auth pointer updates.
- `packages/junior/src/chat/services/vision-context.ts`: image summary state hydration.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/services/conversation-memory.test.ts`
  - `packages/junior/tests/unit/services/context-compaction.test.ts` for visible/Pi compaction adjacency
  - `packages/junior/tests/unit/services/pending-auth.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/message-content-behavior.test.ts`
  - `packages/junior/tests/integration/slack/bot-handlers.test.ts`
  - `packages/junior/tests/integration/slack/bot-image-hydration.test.ts`
  - `packages/junior/tests/integration/slack/attachment-media-behavior.test.ts`
  - `packages/junior/tests/integration/oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/turn-resume-slack.test.ts`
- Evals:
  - Thread continuity and passive behavior evals consume conversation context, but model interpretation belongs to `agent-turn-handling` and `agent-prompt`.

### Package Docs And Scripts

- Root `AGENTS.md`: integration default for runtime wiring, evals for model interpretation.

## Prior Art

- Platform or API docs:
  - Slack threads provide visible user/assistant conversation context, but Junior keeps normalized local state for routing and prompt construction instead of repeatedly fetching Slack history.
- SDK/source references:
  - Chat SDK thread state is persisted via `thread.state` / `thread.setState`; Junior stores a typed envelope under `conversation`.
  - Agent session resumability uses a separate Pi/session projection, so conversation state should not become a duplicate model transcript.
- Comparable product or agent behavior:
  - Chatbot systems commonly separate visible channel transcript state from internal model run/session logs because routing, UI, and model replay have different retention and safety needs.

## Implemented Behavior

- Behavior that code currently enforces:
  - Unknown persisted state coerces to a schema-versioned default conversation state.
  - Malformed messages, compactions, pending auth, and vision summaries are omitted.
  - Incoming and queued Slack messages become normalized visible conversation messages.
  - Upserts merge message metadata by id.
  - Thread backfill seeds bounded prior messages from history or recent messages and avoids messages newer than the current turn.
  - Context rendering emits compactions and live transcript with metadata.
  - Visible context compaction summarizes older messages, keeps a minimum live tail, and prunes compaction history.
  - Image summaries are rendered by file id on referenced messages.
  - Title source selection uses earliest human-authored message, ignoring bot-authored user messages.
  - Processing state stores active turn id, last session id, last completed time, and pending auth pointer.
- Behavior that tests currently verify:
  - Title source selection.
  - Empty context rendering.
  - Slack message content and queued context propagation through integration tests.
  - Image hydration and recovered screenshot context through integration tests.
  - Pending auth helper behavior.
  - Resume callbacks rebuild from persisted thread state in OAuth/MCP integration tests.
- Behavior that appears accidental or weakly enforced:
  - Conversation-state coercion has little direct unit coverage for malformed persisted data.
  - Visible conversation compaction reducer coverage is not clearly isolated from Pi compaction tests.
  - `conversation.piMessages` remains in the schema although session-log/turn-session projections are the target Pi history authority.
  - Retention/TTL policy for visible conversation state is not explicit in this capability.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Persist visible Slack thread memory locally and render it for routing/prompt context.
  - Preserve skipped passive messages and reply markers for future context.
  - Keep image analysis summaries attached by file id and avoid inventing missing image content.
  - Use processing pointers only to find owned session/auth state.
  - Keep visible compactions bounded and separate from Pi-history compaction.
- Behavior that should remain implementation detail:
  - Exact XML-ish rendering tags.
  - Exact compaction batch sizes and summary prompt wording.
  - Exact message placeholder text.
  - Exact state-adapter key names/TTL until storage policy is accepted.
- Behavior that should be non-goal:
  - Canonical Pi replay history.
  - Slack final delivery formatting.
  - Model answer quality itself.

## Undefined Behavior / Open Questions

| Question                                                 | Evidence                                                                                 | Options                                                                     | Recommendation                                                               | Status |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| Should `conversation.piMessages` stay in schema?         | Schema includes it; session-log spec owns Pi history.                                    | Keep transitional, remove, or replace with pointer only.                    | Treat as transitional until session-log migration is complete.               | open   |
| What is visible conversation-state retention/TTL?        | State patch updates stats; TTL governed elsewhere.                                       | Fixed TTL, workspace policy, no explicit TTL, or compaction-only.           | Define in storage/queue state spec or this capability after audit.           | open   |
| Who owns visible compaction details?                     | `conversation-memory.ts` implements it; `context-compaction.md` describes both surfaces. | Keep here, move to context-compaction, or split.                            | State shape/reducer here; model-history compaction in `context-compaction`.  | open   |
| Are malformed persisted fields silently dropping enough? | Coercion omits malformed entries.                                                        | Silent repair, log warnings, fail loudly for some fields.                   | Keep tolerant visible state; fail-loud belongs to session-log model history. | open   |
| Which processing fields are permanent?                   | `activeTurnId`, `lastSessionId`, `pendingAuth` bridge multiple systems.                  | Permanent read model, transitional pointers, or move to per-concern stores. | Keep as routing read model and avoid model-visible meaning.                  | open   |

## OpenSpec Requirements Draft

| Requirement                           | Scenarios                                                     | Source Evidence                                          | Notes                             |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Visible conversation state authority  | Prompt background, Pi history separation, processing pointers | `chat-architecture.md`, `conversation.ts`, session specs | Key ownership boundary.           |
| State coercion and versioned defaults | Missing, malformed messages, malformed pending auth, patch    | `conversation.ts`                                        | Add unit coverage.                |
| Visible message upsert and metadata   | New message, queued messages, duplicate id, placeholder       | `turn-preparation.ts`, `conversation-memory.ts`          | Integration coverage broad.       |
| Visible thread backfill               | Already complete, existing memory, history, recent fallback   | `turn-preparation.ts`                                    | Needs isolated tests if risky.    |
| Conversation context rendering        | Empty, compactions, messages, exclude current                 | `conversation-memory.ts`                                 | Exact text not stable.            |
| Visible conversation compaction       | Threshold, prune/merge, summary failure                       | `conversation-memory.ts`                                 | Split from Pi compaction.         |
| Vision summary state                  | Referenced summaries, missing summaries, backfill state       | `vision-context.ts`, image tests                         | Cross-link attachment-and-vision. |
| Thread title source                   | Human source, bot-authored ignore                             | unit tests                                               | Good pure coverage.               |
| Verification taxonomy                 | Unit, integration, eval boundary                              | `testing.md`                                             | Evals owned elsewhere.            |

## Migration Notes

- Canonical spec updates:
  - Add `conversation-state` to the canonical index after acceptance.
  - Keep `chat-architecture.md` as overview and link here for state shape/ownership.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Do not move Pi-history rules from `agent-session-resumability`.
  - Do not move model-history compaction rules from `context-compaction`.
- Test/eval taxonomy changes:
  - Add or split unit tests for coercion/visible compaction after review.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-conversation-state' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: malformed state coercion, visible compaction reducer coverage, retention/TTL policy, and `conversation.piMessages` migration.
