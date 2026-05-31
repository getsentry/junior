## Context

The canonical `specs/context-compaction.md` defines two context surfaces:

- reusable Pi history loaded from the agent session log for future turns
- persisted Slack conversation state used for routing, thinking selection, and fallback prompt background

Current implementation covers the first surface through `createContextCompactor(...)` and `context-budget.ts`. It estimates reusable Pi history supplied by the runtime, summarizes oversized history with the fast model, builds replacement history from retained user messages plus one handoff summary, and persists that replacement through the conversation session log. When the replacement differs from the current projection, `commitMessages(...)` appends a `projection_reset` event and advances the conversation-local `sessionId`. Slack runtime integration then uses the compacted Pi messages for the next turn and shows assistant status while summarization runs.

The remaining target gap is narrower: compaction now uses the same conversation log and projection-reset/session-marker model, but reset identity is still derived from reset count (`session_#`) rather than a stable source event id or explicit idempotency key.

Prior art is local and adjacent: Pi/Codex-style agents keep a durable ordered history and compact by replacing the model-visible projection with a handoff summary plus a retained tail. Runtime turn context remains volatile and is reinjected by the next real turn instead of being stored inside the compacted history.

## Goals / Non-Goals

**Goals:**

- Specify how reusable Pi history is compacted before a later turn starts.
- Keep visible Slack conversation-state compaction separate from Pi-history compaction.
- Define retained-message and handoff-summary shape without over-specifying exact prose.
- Record target/current gaps around session-log projection events, session markers, and deterministic idempotency.
- Keep verification split between pure compaction mechanics, Slack runtime wiring, and eval continuity.

**Non-Goals:**

- Defining a stable source-position event id for compaction resets in this change.
- Adding user-facing compaction commands or model tools.
- Defining mid-turn compaction.
- Replacing timeout/auth resumability behavior.
- Specifying raw summarizer prompt text as a stable contract.

## Decisions

### Decision: Use same-log projection reset semantics

Compaction persists as append-only projection replacement in the reusable conversation history. Current code appends through `commitMessages(...)`; when the replacement diverges from the active projection, the session log writes one `projection_reset` and advances the conversation-local `sessionId`. Future Pi projection and derived runtime handles are reduced from entries in the active session marker.

Alternatives considered:

- Specify a separate compaction session record: rejected because the current implementation no longer forks a synthetic `compaction_<session>` record and the canonical source should remain the conversation session log.
- Require full deterministic event ids now: rejected because the current reset marker provides bounded active-session filtering, while source-position idempotency can be added with the broader event-envelope work.

### Decision: Keep current runtime context out of compacted history

Compaction should summarize durable thread context and reusable Pi history, not store current requester/runtime/tool capability blocks. The next turn should reinject volatile context through `buildTurnContextPrompt(...)`.

Alternatives considered:

- Persist full prompt input in the compacted history: rejected because stale requester, runtime, skill, and MCP catalog facts would be replayed later.
- Drop all user wording and keep only a summary: rejected because recent real user messages often carry exact phrasing needed for follow-up interpretation.

### Decision: Treat summarization failure as non-fatal

Automatic pre-turn compaction is an optimization before model execution. If summary generation fails, Junior should continue with prior history unless the provider has already rejected the prompt as too large.

Alternatives considered:

- Fail the user turn on compaction failure: rejected because compaction is a preflight optimization, not the user's requested work.
- Retry indefinitely: rejected because compaction must not block the turn forever.

## Risks / Trade-offs

- [Risk] Current reset identity is not source-position deterministic. Mitigation: requirements keep idempotency visible as the remaining target/current gap.
- [Risk] Compaction drops runtime handles needed by future turns. Mitigation: spec requires rediscovery/reload through normal capability paths when old handle evidence is omitted.
- [Risk] Summary quality becomes the whole behavior contract. Mitigation: structural compaction is unit/integration tested; model continuity belongs in evals.
- [Risk] Visible conversation-state compaction is under-specified. Mitigation: keep it as an explicit open question and cross-link `conversation-state`.

## Open Questions

- What deterministic idempotency key should represent one compaction source position?
- Is visible Slack conversation-state compaction owned here, or should this capability only constrain it while `conversation-state` owns the concrete state shape?
- Which long-thread continuity evals should be added or moved under this capability?
- Should future mid-turn compaction exist, and if so how does it prove Pi `continue()` remains safe?

## Migration Plan

1. Validate this OpenSpec change.
2. Review target/current gaps against `specs/context-compaction.md`.
3. After acceptance, archive this capability into `openspec/specs/context-compaction/spec.md`.
4. Plan a follow-up implementation change for deterministic compaction reset identity if desired.
5. Use the verification map to add missing eval/integration coverage after the spec is accepted.
