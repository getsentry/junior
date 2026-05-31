# Backfill Worksheet: `agent-session-resumability`

## Scope

- Capability: Agent session resumability
- Change: `backfill-agent-session-resumability`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/agent-session-resumability/spec.md` after review; current prose source remains `specs/agent-session-resumability.md`

## Current-Source Inventory

### Existing Specs And Policies

- `specs/agent-session-resumability.md`: primary target contract for durable session logs, pause/resume, Pi projection, timeout callbacks, provider retry, and failure recovery.
- `specs/slack-agent-delivery.md`: user-visible Slack continuation notices, auth-pause acknowledgements, and final resumed reply delivery.
- `specs/oauth-flows.md`: plugin/MCP auth interrupt flow, `authorization_requested`/`authorization_completed` event ownership, private-link delivery, and thread-local pending auth boundaries.
- `specs/context-compaction.md`: projection resets and session-marker advancement for compacted Pi history.
- `specs/harness-agent.md`: Pi agent loop, message projection, and final output resolution.
- `specs/chat-architecture.md`: queue/lock ownership and runtime/service boundaries.
- `specs/testing.md`: unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/state/session-log.ts`: append-only Pi projection log with `pi_message`, `projection_reset`, `mcp_provider_connected`, `authorization_requested`, and `authorization_completed`; `projection_reset` advances the conversation-local `sessionId` marker.
- `packages/junior/src/chat/state/turn-session.ts`: versioned `AgentTurnSessionRecord` read model and materialized Pi-message loading.
- `packages/junior/src/chat/services/turn-session-record.ts`: safe-boundary persistence, completed/timeout/auth session records, cumulative diagnostics.
- `packages/junior/src/chat/services/timeout-resume.ts`: signed callback scheduling, verification, depth cap, and awaiting-continuation request creation.
- `packages/junior/src/chat/respond.ts`: Pi state restoration, session bootstrap context detection/injection, `continue()`, timeout abort handling, auth pause handling, provider retry, MCP/skill restoration.
- `packages/junior/src/chat/runtime/slack-resume.ts`: resumed Slack turn execution, lock, status, processing reaction, final delivery success/failure.
- `packages/junior/src/handlers/turn-resume.ts`: internal timeout-resume callback handler and runtime state reconstruction.
- `packages/junior/src/handlers/oauth-callback.ts` and `packages/junior/src/handlers/mcp-oauth-callback.ts`: auth resume and stale callback handling.
- `packages/junior/src/chat/services/context-compaction.ts`: pre-turn compaction writes replacement history through session-log projection reset.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/state/session-log.test.ts`
  - `packages/junior/tests/unit/services/turn-session-record.test.ts`
  - `packages/junior/tests/unit/runtime/timeout-resume.test.ts`
  - `packages/junior/tests/unit/runtime/respond-timeout-resume.test.ts`
  - `packages/junior/tests/unit/runtime/respond-provider-retry.test.ts`
  - `packages/junior/tests/unit/handlers/turn-resume.test.ts`
  - `packages/junior/tests/unit/handlers/oauth-resume.test.ts`
- Integration:
  - `packages/junior/tests/integration/turn-resume-slack.test.ts`
  - `packages/junior/tests/integration/oauth-resume-slack.test.ts`
  - `packages/junior/tests/integration/oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
  - `packages/junior/tests/integration/slack/bot-handlers.test.ts`
  - `packages/junior/tests/integration/slack/message-content-behavior.test.ts`
  - `packages/junior/tests/integration/agent-dispatch-runner.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/oauth-workflows.eval.ts`: auth resume continuity and same-thread resumed answer expectations.
  - Additional timeout-resume or long-turn eval mapping should be audited during eval taxonomy work.
- Fixtures/MSW:
  - Slack MSW handlers for final resumed delivery and file upload behavior.
  - Eval auth/OAuth plugin fixtures for resume workflows.

### Package Docs And Scripts

- `packages/junior-evals/README.md`: eval behavior layer.
- Root `AGENTS.md`: eval vs integration testing rules and Slack delivery pointers.

## Prior Art

- Platform or API docs:
  - Vercel/serverless execution imposes finite function durations; Junior's timeout continuation is a product response to that class of runtime limit.
- SDK/source references:
  - Pi agent integration in this repo relies on restoring `agent.state.messages` and calling `agent.continue()` to resume generation/tool loop from a projected history.
  - Current code treats `agent.state.messages` as the replayable Pi state and stores Junior-only MCP provider connection facts outside Pi projection.
- Comparable product or agent behavior:
  - Append-only event logs with derived projections are standard for durable recovery because they allow reset/branch facts without mutating audit history.
  - Codex/Pi-style compaction treats summaries as model-history projection changes, not as a second transcript.
  - Host-controlled permission and authorization systems keep approval/auth enforcement outside prompt text; the model resumes from host-owned runtime facts.
- Notes on applicability:
  - Prior art supports projection-reset and replay semantics; Junior-specific Slack final delivery and callback locking remain repo-owned behavior.
  - Prior art supports auth as an interrupt in chronological session history, not as a volatile prompt flag.

## Implemented Behavior

- Behavior that code currently enforces:
  - Session log appends growing Pi messages and projection resets instead of rewriting prior entries.
  - Projection resets advance the active conversation-local `sessionId`; projection and derived MCP/auth reducers use active-session entries by default.
  - Turn-session records store `committedMessageCount` plus the session-log projection marker (`logSessionId`) and materialize Pi messages from the session log instead of persisting a second Pi transcript.
  - Runtime prompt context is treated as session bootstrap context: ordinary follow-ups skip duplicate bootstrap blocks when the restored Pi projection already carries one; compaction replacement history omits old bootstrap so the next projection receives fresh bootstrap.
  - Connected MCP providers are recorded once and filtered out of Pi message projection.
  - `authorization_requested` and `authorization_completed` are typed session-log entries with dedupe by `authorizationId`.
  - `authorization_requested` is filtered out of Pi projection; `authorization_completed` projects to a deterministic host-authored Pi-compatible observation using the event timestamp.
  - Plugin and MCP auth orchestration record `authorization_requested` after private-link delivery succeeds or a fresh pending link is reused.
  - Plugin and MCP OAuth callbacks record `authorization_completed` inside the locked resume preparation path before returning resume context.
  - Turn-session records materialize Pi messages by committed message count and `logSessionId`, and preserve lifecycle, slice id, version, pause reason, cumulative usage/duration, and error message.
  - Running records persist only at continuable user/tool-result boundaries.
  - Timeout/auth pause records trim unsafe assistant tails and fall back to the latest safe boundary.
  - Timeout callback payloads are HMAC-signed and timestamp-checked.
  - Timeout callbacks validate expected session record version, state, resume reason, active turn id, and Slack thread id before resume.
  - Resume callbacks retry briefly on lock busy, then reschedule.
  - Resumed timeout slices can schedule a later slice until the configured cap.
  - OAuth/MCP callbacks abandon stale records when newer user work supersedes the paused request.
  - Resumed final replies use shared Slack delivery and commit conversation/thread state only after delivery.
  - Canonical OAuth prose now says auth pause appends `authorization_requested`, auth completion appends `authorization_completed`, and thread `pendingAuth` is callback routing/dedupe only.
- Behavior that tests currently verify:
  - Session log append/reset/session-marker filtering/MCP provider projection.
  - Session log auth event dedupe and deterministic completion projection.
  - Safe-boundary trimming, empty-boundary rejection, and projection-pin behavior across resets.
  - Cumulative diagnostics across paused/resumed records.
  - Signed callback generation and tamper rejection.
  - Callback stale/drop, lock-busy retry/reschedule, slice-depth exhaustion, and post-delivery commit failure.
  - Slack resumed reply status, final message, files, and persisted completion.
  - Auth resume same-thread continuity via integration tests and evals.
- Behavior that appears accidental or weakly enforced:
  - Full target event family is specified but not implemented.
  - Auth interrupt event implementation exists, but end-to-end coverage should still prove both plugin and MCP callback ordering, prompt exclusion, and public/private Slack delivery boundaries.
  - `pause_event_id` and full event envelope fields are specified in canonical prose but current callback validity uses `expectedVersion`, and current entries do not yet carry full event ids/conversation ids/turn ids.
  - `AgentTurnSessionRecord` is described as transitional in prose, but implementation still depends on it heavily as a lifecycle/read model.
  - Visible-output detection is simple today because Slack text is finalized-only; future streaming would need a stronger marker.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Resume only from safe Pi continuable boundaries.
  - Preserve durable Pi history across timeout/auth/serverless slices.
  - Represent plugin/MCP authorization request and completion as chronological session-log interrupt events.
  - Project auth completion into Pi as a single host-authored internal observation during resume, not as a Slack user message or turn-context prompt flag.
  - Restore runtime handles before `continue()`.
  - Reject stale or tampered callbacks.
  - Keep final delivery as the success gate for resumed turns.
  - Avoid duplicate visible work when users poke an awaiting continuation.
- Behavior that should remain implementation detail:
  - Exact Redis/list backend and key TTL values.
  - Exact retry delay list for lock busy.
  - Internal names of session-record helper functions.
  - Exact callback signing header names, as long as the authenticated contract holds.
  - Exact Pi storage representation for the host-authored auth observation, as long as the canonical session log is the source and projection is deterministic.
- Behavior that should be non-goal:
  - Mid-tool-call persistence.
  - Automatic reconciliation of already-visible partial Slack output.
  - Generic durable workflow engine semantics.
  - Auth provider credential storage rules.
  - Scope-level model behavior for auth unless separately specified.

## Undefined Behavior / Open Questions

| Question                                                                 | Evidence                                                                                                                                                                                    | Options                                                                                                                                          | Recommendation                                                                                                                                   | Status  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| When should callbacks switch from `expectedVersion` to `pause_event_id`? | Canonical spec names `pause_event_id`; implementation uses version.                                                                                                                         | Keep version, add pause event id, or support both during migration.                                                                              | Track as implementation follow-up; do not claim complete target support.                                                                         | open    |
| Is `AgentTurnSessionRecord` permanent?                                   | Spec calls records transitional; code depends on them for lifecycle and validation, but Pi messages are now materialized from session log using `committedMessageCount` and `logSessionId`. | Keep as read model, rebuild from full log, or remove after reducer exists.                                                                       | Keep as a lifecycle/read model until full event reducer is implemented; do not treat it as a second Pi transcript.                               | open    |
| Should `sessionId` mean projection marker only?                          | Root spec now separates `conversation_id`, conversation-local `session_id`, and turn-level `turn_id`; older OpenSpec text treated session id as the turn id.                                | Rename code-facing fields, keep current names with clearer prose, or support both during migration.                                              | Treat `sessionId` in session-log entries as projection marker; use `turnId` for resumable execution identity in canonical prose.                 | decided |
| Which non-auth target events come next?                                  | Current session-log schema had only three entry types; OAuth spec now names auth interrupt events.                                                                                          | Add pause/delivered/error events first, or only when replacing record state.                                                                     | Treat `authorization_requested`/`authorization_completed` as the first auth event family, then add other events when they remove real ambiguity. | updated |
| How exactly should auth completion be represented in Pi?                 | OAuth spec requires deterministic projection; Pi may or may not support custom app messages cleanly.                                                                                        | Store custom app message and map in `convertToLlm`, or store canonical session event and materialize a Pi-compatible message at projection time. | Keep session event canonical; choose the narrowest Pi-compatible projection implementation during implementation.                                | open    |
| Should thread `pendingAuth` appear in prompt context?                    | OAuth spec says pending auth is callback routing/dedupe only.                                                                                                                               | Render it in `buildTurnContextPrompt`, render only completion provider, or never render auth lifecycle state.                                    | Never render auth lifecycle state; project completion from session history exactly once.                                                         | decided |
| Should callback delivery have a sweeper?                                 | Failure model says no sweeper today.                                                                                                                                                        | Keep callback/user-follow-up/operator only, or add scheduled sweeper.                                                                            | Leave unspecified beyond current best-effort callback.                                                                                           | open    |
| How will visible-output checks work with future streaming?               | Current Slack spec posts final text only.                                                                                                                                                   | Add delivery-start marker, rely on Slack delivery state, or forbid streaming.                                                                    | Defer until streaming becomes product contract.                                                                                                  | open    |

## OpenSpec Requirements Draft

| Requirement                               | Scenarios                                                                                        | Source Evidence                                                                         | Notes                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Session identity and state partition      | Turn starts, projection reset, state persisted, runtime state ownership, transitional read model | `agent-session-resumability.md`, `session-log.ts`, `turn-session.ts`, `thread-state.ts` | Distinguish conversation id, projection session id, turn id, and slice id.               |
| Append-only session log and Pi projection | Grow, reset, Junior-only facts, invalid data                                                     | `session-log.ts`, `session-log.test.ts`                                                 | Full target schema not implemented.                                                      |
| Safe pause boundaries                     | User/toolResult, unsafe assistant tail, empty boundary, in-flight tool                           | `turn-session-record.ts`, `turn-session-record.test.ts`                                 | Critical correctness boundary.                                                           |
| Pi resume execution                       | Awaiting resume, prior session history, bootstrap detection/injection, refreshed context         | `respond.ts`, `message-content-behavior.test.ts`                                        | Cross-link harness-agent and agent-prompt.                                               |
| Timeout pause and continuation            | Timeout, persistence failure, depth limit, user follow-up                                        | `respond.ts`, `timeout-resume.ts`, `bot-handlers.test.ts`                               | No sweeper today.                                                                        |
| Signed timeout callback                   | Auth, stale, valid, busy, repeated timeout                                                       | `timeout-resume.ts`, `turn-resume.ts`, tests                                            | Current payload uses expectedVersion.                                                    |
| Authorization interrupt event history     | Requested event, completed event, projection, prompt exclusion, pendingAuth routing-only         | `oauth-flows.md`, OAuth/MCP handlers/tests                                              | Auth event implementation needs code verification.                                       |
| Auth pause and authorization resume       | Pause, current callback, stale callback, re-pause                                                | OAuth/MCP handlers/tests                                                                | Credential semantics owned elsewhere; callback routing state stays out of model context. |
| Runtime handle restoration                | Skills, MCP providers, provider record, artifacts/sandbox                                        | `respond.ts`, session-log tests, MCP tests                                              | Legacy inference still allowed.                                                          |
| Provider retry before delivery            | Transient error, unsafe boundary, retry limit                                                    | `respond.ts`, `respond-provider-retry.test.ts`                                          | Not an awaiting resume.                                                                  |
| Resume completion/failure finalization    | Delivery success, delivery failure, post-delivery commit failure, terminal failure               | `slack-resume.ts`, `turn-resume.ts`, integration tests                                  | User-visible delivery owned by Slack spec.                                               |
| Verification taxonomy                     | Unit, integration, eval                                                                          | `specs/testing.md`                                                                      | Eval mapping remains follow-up.                                                          |

## Migration Notes

- Canonical spec updates:
  - Keep `specs/agent-session-resumability.md` authoritative until this OpenSpec baseline is accepted.
  - Add explicit target/current notes for `pause_event_id` versus `expectedVersion`.
  - Clarify whether `AgentTurnSessionRecord` is a read model, migration cache, or permanent lifecycle index.
  - Keep auth interrupt semantics aligned with `specs/oauth-flows.md`: session-log events are canonical; prompt context does not carry auth lifecycle flags.
- Index/pointer updates:
  - No index update needed for this draft because `specs/agent-session-resumability.md` is already listed.
- Superseded content:
  - None yet. Do not archive canonical prose during this spec-only draft.
- Test/eval taxonomy changes:
  - Defer test/eval rename/split work until after review.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-agent-session-resumability' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: auth interrupt event implementation/projection, full non-auth event-family schema, `pause_event_id` migration, `AgentTurnSessionRecord` permanence, session bootstrap duplication boundaries, sweeper behavior, and future visible-output streaming markers.
