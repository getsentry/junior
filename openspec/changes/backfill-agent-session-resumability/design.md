## Context

The target canonical spec describes a durable append-only agent session log with typed event families, pause event identifiers, and deterministic projection into Pi messages. The current implementation has implemented the most important user-visible mechanics but is still transitional:

- `state/session-log.ts` stores append-only `pi_message`, `projection_reset`, `mcp_provider_connected`, and auth interrupt entries. `projection_reset` advances a conversation-local `sessionId` marker used to filter active projection entries, similar to the Codex/Pi compaction model.
- `state/turn-session.ts` stores a versioned `AgentTurnSessionRecord` read model with lifecycle, slice id, committed message count, diagnostics, and resume reason.
- Timeout continuation callbacks carry `conversationId`, `sessionId`, and `expectedVersion`, not the target `pause_event_id`.
- `specs/oauth-flows.md` now treats plugin and MCP authorization as session-log interrupt events: `authorization_requested` after private link delivery/reuse and `authorization_completed` before resume.
- `respond.ts` restores Pi through `agent.state.messages = ...`, detects whether the restored projection already carries session bootstrap context, injects bootstrap context only when needed, and resumes with `agent.continue()` for awaiting records.
- Slack timeout and auth resumes rebuild runtime state from persisted thread/configuration/artifact/sandbox state and use shared final delivery behavior.

Prior art is primarily local and library-adjacent: Pi exposes durable replay by assigning `agent.state.messages` and continuing the run; Junior's session log follows the common append-only event-log pattern where projection resets are appended instead of rewriting historical entries; Codex/Pi-style compaction is treated as model-history projection, not as a separate transcript. Host-controlled authorization and tool approval systems, including Codex and Claude Code, keep authorization/permission enforcement outside prompt prose and resume the model from runtime-owned facts.

## Goals / Non-Goals

**Goals:**

- Specify the behavior Junior must preserve for safe single-turn continuation.
- Separate canonical session history from transitional read models and thread state.
- Record open questions where the target spec and implementation differ.
- Keep Slack user-visible notices and final delivery linked to `slack-agent-delivery`.
- Keep verification taxonomy clear: pure reducer/signing tests as unit, runtime resume behavior as integration, reply-quality continuity as eval.

**Non-Goals:**

- Implementing the full target event-family schema in this change.
- Removing `AgentTurnSessionRecord` or replacing expected-version callback validation.
- Specifying a generic queue/lease workflow runtime.
- Persisting mid-tool-call state or reconciling already-visible partial Slack output.
- Rewriting OAuth, MCP, Slack, or context-compaction behavior beyond cross-linking their session-log event ownership.

## Decisions

### Decision: Specify target semantics while labeling transitional mechanics

The OpenSpec requirements describe the durable behavior Junior needs: append-only model history, safe pause boundaries, Pi projection, session-marker resets, and stale callback rejection. The worksheet records that current code has implemented projection resets and auth interrupt entries but still uses a narrower-than-target session-log envelope overall and `expectedVersion` rather than the final `pause_event_id` callback contract.

Alternatives considered:

- Specify only the current record-based design: rejected because it would canonize a transitional read model as the intended durable architecture.
- Specify only the target event family: rejected because the user asked to verify what is implemented and what is not.

### Decision: Keep safe boundaries narrower than general crash recovery

Junior may resume only from continuable Pi boundaries: user or tool-result tails after trimming unsafe assistant-only output. The spec forbids mid-tool-call persistence because the current implementation cannot prove side-effect idempotency for that boundary.

Alternatives considered:

- Snapshot every partial model state: rejected because partial assistant text and in-flight tools are not safe to replay.
- Treat any persisted messages as resumable: rejected because assistant-only tails can duplicate or corrupt a continuation.

### Decision: Treat automatic timeout continuation as best-effort bounded recovery

Timeout continuation exists to survive platform limits before visible assistant output starts. It is scheduled by signed internal callback and bounded by slice count; when the callback is stale, invalid, exhausted, or unable to acquire the lock, it exits, retries, reschedules, or fails according to deterministic rules.

Alternatives considered:

- Add a sweeper/queue requirement: rejected because the implementation uses signed callback scheduling today.
- Retry forever: rejected because a bad turn could loop indefinitely.

### Decision: Keep runtime state partition explicit

Session history owns Pi message projection and model-runtime handles that can be reduced from it. Thread state owns mutable Slack conversation state, artifacts, sandbox identity, pending auth, and visible delivery state. Channel configuration is reloaded from configuration services on resume.

Alternatives considered:

- Copy all resume state into session records: rejected because it duplicates canonical stores and risks stale resumes.
- Reload everything from Slack history: rejected because Slack delivery and context specs already prefer persisted local state.

### Decision: Treat runtime prompt context as session bootstrap

Runtime prompt context is not a per-message cache. It is bootstrap material for the active Pi projection. Once the projection already contains the `<runtime-turn-context>` bootstrap marker, ordinary follow-up turns append only the user input. When compaction creates a replacement projection or an explicit resume boundary needs fresh runtime facts, Junior reinjects bootstrap context from canonical services.

Alternatives considered:

- Strip runtime context from every completed session record: rejected because the branch now uses Pi session projections in the Codex-style model where a session carries one bootstrap context and ordinary follow-ups avoid repeating it.
- Reinject bootstrap context on every user message: rejected because it bloats durable history and can replay stale requester/artifact/configuration facts as if they were new user content.

### Decision: Treat authorization as a session-log interrupt

Plugin and MCP authorization pauses are chronological runtime facts. The session log should record `authorization_requested` after the private link is delivered or reused and `authorization_completed` after callback validation and credential storage. Resume projection then materializes a small host-authored internal observation for Pi exactly once in order. The observation should communicate only the operational fact the model needs: the provider is now authorized, so the blocked provider operation can be retried.

Thread `pendingAuth` remains necessary, but only for callback routing, deduplication, and stale-resume suppression. It must not be rendered into the prompt or used as a model-facing auth-completion hint.

Alternatives considered:

- Add `pendingAuth` or `authorization_completed_provider` to `buildTurnContextPrompt(...)`: rejected because it smuggles lifecycle state into volatile prompt context and can be re-injected on unrelated resumed turns.
- Store auth completion only in thread state: rejected because the model learns the fact by resuming from chronological session history, not from Slack/thread routing state.
- Include URLs, tokens, codes, or scopes in auth events: rejected because the model only needs the fact of completion unless scope-level behavior is later specified.

## Risks / Trade-offs

- [Risk] The OpenSpec target exceeds implementation. Mitigation: worksheet calls out unimplemented or transitional fields such as `pause_event_id` and full event families.
- [Risk] Session-log/read-model boundaries remain unclear. Mitigation: requirements name which facts belong to session log, session projection, and thread state.
- [Risk] Resume quality is over-tested at transport level. Mitigation: verification map pushes natural-language continuity to evals.
- [Risk] Auth resume and timeout resume become conflated. Mitigation: requirements keep pause reason and resume validation separate.
- [Risk] Auth completion could be injected twice through both prompt context and session projection. Mitigation: the spec forbids auth lifecycle prompt flags and keeps `pendingAuth` routing-only.
- [Risk] Bootstrap context can become stale across long-lived sessions. Mitigation: compaction resets the projection, resumed boundaries refresh from canonical services, and ordinary follow-up turns do not duplicate old bootstrap blocks.

## Open Questions

- When should `expectedVersion` callback validation be replaced by target `pause_event_id` validation?
- Should `AgentTurnSessionRecord` remain an explicit read model after the full event reducer exists, or should it become a cache rebuilt entirely from the session log?
- Which non-auth target session-log event families should be implemented first beyond current `pi_message`, `projection_reset`, `mcp_provider_connected`, `authorization_requested`, and `authorization_completed`?
- Should automatic timeout continuation get a durable sweeper for callback delivery failures, or remain dependent on callbacks/user follow-up/operator action?
- How should visible-output detection be represented once any future Slack streaming feature posts text before final delivery?

## Migration Plan

1. Validate this OpenSpec change.
2. Review target/current gaps against `specs/agent-session-resumability.md`.
3. After acceptance, archive this capability into `openspec/specs/agent-session-resumability/spec.md`.
4. Plan a follow-up implementation change for target event-family schema and `pause_event_id` if desired.
5. Use the verification map to split or rename tests only after the spec is accepted.
