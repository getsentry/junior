## 1. Source Inventory

- [x] 1.1 Review `specs/agent-session-resumability.md` and adjacent canonical specs for ownership boundaries.
- [x] 1.2 Inspect implementation paths: session log, turn session record, timeout resume signing/scheduling, agent response timeout/auth handling, Slack resume runtime, and internal turn-resume handler.
- [x] 1.3 Inventory unit/integration/eval coverage for session log, safe boundaries, timeout callbacks, auth resume, provider retry, MCP restoration, and Slack final delivery.
- [x] 1.4 Review local Pi/agent prior art relied on by implementation: `agent.state.messages`, `continue()`, append-only session entries, and projection reset semantics.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-agent-session-resumability`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `agent-session-resumability`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [x] 3.1 Compare OpenSpec requirements with `specs/agent-session-resumability.md` and mark target/current implementation mismatch, including the newer projection-session `sessionId` model.
- [ ] 3.2 Decide whether `pause_event_id` should replace `expectedVersion` in the callback contract.
- [ ] 3.3 Decide whether `AgentTurnSessionRecord` is a permanent read model or a migration cache.
- [x] 3.4 Decide the first auth session-log event family: `authorization_requested` and `authorization_completed` are canonical session-history facts; thread `pendingAuth` is routing/dedupe only.
- [ ] 3.5 Decide which non-auth target session-log event families should be implemented beyond current `pi_message`, `projection_reset`, `mcp_provider_connected`, and auth interrupt events.
- [ ] 3.6 Verify current implementation fully matches the auth interrupt boundary: events stored, completion projected exactly once, and prompt lifecycle flags removed.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add` and `split` entries into follow-up tasks after review.
- [ ] 4.2 Map resume-related evals to this capability versus `agent-turn-handling`, `agent-prompt`, and `slack-agent-delivery`.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-agent-session-resumability`.
- [x] 5.2 Record validation results and deferred runtime/test verification.
