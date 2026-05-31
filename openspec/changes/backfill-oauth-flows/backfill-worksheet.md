# Backfill Worksheet: `oauth-flows`

## Scope

- Capability: OAuth flows
- Change: `backfill-oauth-flows`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/oauth-flows.md` plus `openspec/specs/oauth-flows/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/oauth-flows.md`: existing prose contract.
- `specs/security-policy.md`: auth-link privacy and token secrecy.
- `specs/credential-injection.md`: lazy requester-bound credential leases after OAuth.
- `specs/agent-session-resumability.md`: auth session-log events, Pi projection, awaiting-resume lifecycle.
- `specs/slack-agent-delivery.md`: URL-free public acknowledgement, same-thread callback resume, stale resume suppression.
- `specs/mcp-tool-runtime.md`: MCP auth interruption and provider activation behavior.
- `specs/plugin-runtime.md`: OAuth provider config and plugin auth.
- `specs/eval-testing.md` and `specs/testing.md`: verification ownership.

### Code Paths

- `packages/junior/src/chat/oauth-flow.ts`: generic OAuth state creation, base URL resolution, authorization URL construction, private Slack delivery, DM fallback.
- `packages/junior/src/handlers/oauth-callback.ts`: generic callback validation, code exchange, token storage, App Home refresh, session-record resume, stale pending-auth suppression, failure persistence.
- `packages/junior/src/handlers/mcp-oauth-callback.ts`: MCP callback validation, SDK auth finalization, auth session cleanup, same-thread resume, stale pending-auth suppression.
- `packages/junior/src/chat/services/plugin-auth-orchestration.ts`: command auth failure detection, provider selection, pending-link reuse, session-log `authorization_requested`, agent abort.
- `packages/junior/src/chat/services/mcp-auth-orchestration.ts`: MCP auth provider creation, auth URL delivery, pending-link reuse, session-log `authorization_requested`, agent abort.
- `packages/junior/src/chat/mcp/oauth.ts`: MCP auth provider/session creation and SDK `finishAuth`.
- `packages/junior/src/chat/mcp/auth-store.ts`: MCP auth sessions, credentials, session index, and server session storage.
- `packages/junior/src/chat/state/session-log.ts`: `authorization_requested` and `authorization_completed` event recording/projection.
- `packages/junior/src/chat/services/pending-auth.ts`: pending auth dedupe/routing/stale checks.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/handlers/oauth-callback.test.ts`
  - `packages/junior/tests/unit/handlers/mcp-oauth-callback.test.ts`
  - `packages/junior/tests/unit/services/plugin-auth-orchestration.test.ts`
  - `packages/junior/tests/unit/services/mcp-auth-orchestration.test.ts`
  - `packages/junior/tests/unit/mcp/oauth.test.ts`
  - `packages/junior/tests/unit/mcp/oauth-provider.test.ts`
  - `packages/junior/tests/unit/mcp/auth-store.test.ts`
  - `packages/junior/tests/unit/handlers/oauth-resume.test.ts`
- Integration:
  - `packages/junior/tests/integration/oauth-resume-slack.test.ts`
  - `packages/junior/tests/integration/oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/oauth-workflows.eval.ts`
  - Provider workflow evals that depend on credential providers.

## Prior Art

- OAuth 2.0 authorization code grant is a server-side browser redirect flow where code exchange and token storage happen outside the model.
- OAuth 2.0 refresh-token flow supports server-side access token renewal without another user-facing authorization prompt.
- MCP authorization for HTTP transports is a transport/client responsibility based on OAuth and protected resource metadata.
- Host-controlled approval systems in coding agents treat authorization/permission decisions as runtime state, not prompt text.
- Slack apps use ephemeral channel messages or DMs for requester-private links; public thread messages must not include secrets or user-specific authorization URLs.

Sources:

- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- MCP Authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Codex approvals: https://www.mintlify.com/openai/codex/concepts/approvals
- Slack `chat.postEphemeral`: https://api.slack.com/methods/chat.postEphemeral

## Implemented Behavior

- Behavior that code currently enforces:
  - Generic OAuth state is random, short-lived, provider-bound, requester-bound, and includes resume identifiers when available.
  - Authorization links are delivered via channel ephemeral/DM surfaces with DM fallback; failure to privately deliver prevents the public URL leak.
  - Plugin auth orchestration detects command auth failures, explicit `junior-auth-required` markers, GitHub smart-HTTP auth failures, pending-link reuse, and disabled auth flow mode.
  - MCP auth orchestration creates SDK auth sessions, patches latest configuration/artifacts before link delivery, reuses pending links, deletes transient sessions when auth is disabled, and records auth request events.
  - Generic callbacks validate provider, error/code/state, state existence, provider match, client credentials, base URL, token exchange, token response shape, and scopes before storing tokens.
  - MCP callbacks validate state/code/error and finalize OAuth through SDK transport/auth provider before deleting completed auth sessions.
  - Both callback paths can append `authorization_completed` before resuming the model and pass pending-auth state into reply context for runtime routing.
  - Stale callbacks after newer thread messages abandon the blocked request and do not post stale resumed answers.
  - Resume rebuilds conversation context, Pi messages, artifacts, sandbox state, channel configuration, requester identity, attachment context, and failure/timeout/auth-pause callbacks.
- Behavior that tests currently verify:
  - Callback error pages, state validation, token storage, private delivery behavior, App Home refresh best effort, Slack resume behavior, file/status reply behavior, MCP auth storage/provider behavior, and eval-level context retention after auth.
- Behavior that appears accidental or weakly enforced:
  - Generic OAuth deletes state before token exchange; failed token exchange cannot retry the same link.
  - Session-log completion is recorded in callback `beforeStart`, so callbacks that store tokens but suppress stale resume may not record completion.
  - Public acknowledgement wording is distributed across runtime/Slack delivery.
  - Pending-auth state still lives in thread conversation state; it is routing state but close to model-adjacent history.
  - Some reconnect flows blur "resume original request" versus "post connected confirmation".

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Authorization is a host/runtime interrupt.
  - Authorization completion belongs to chronological session history and Pi projection, not prompt flags.
  - `pendingAuth` is callback routing/dedupe only.
  - Auth URLs/tokens/codes are never model-visible or public-thread visible.
  - Callback resume must be latest-request gated.
- Behavior that should remain implementation detail:
  - Exact HTML callback styling.
  - Exact random state length.
  - Exact OAuth state TTL unless product fixes it.
  - Exact public acknowledgement prose.
- Behavior that should be non-goal:
  - Model-visible auth-management commands.
  - Interactive auth in scheduled/system runs.
  - Credential header injection details.

## Undefined Behavior / Open Questions

| Question                                                                               | Evidence                                                      | Options                                                                                    | Recommendation                                                                     | Status |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------ |
| Should generic OAuth state be deleted before token exchange?                           | Current callback deletes state before exchange.               | Delete before, delete after success, or mark consumed with retry window.                   | Review for browser refresh/retry UX.                                               | open   |
| Should completion be recorded when stale callback stores tokens but suppresses resume? | Current completion recording is tied to resume `beforeStart`. | Record all completions, record only resumed completions, or add stale completion event.    | Record only if model-visible resume needs it; otherwise keep token storage silent. | open   |
| Who owns public acknowledgement wording?                                               | Slack delivery and auth orchestration both imply behavior.    | OAuth spec, Slack delivery spec, or shared helper.                                         | Slack delivery owns wording; OAuth owns URL-free invariant.                        | open   |
| Should pendingAuth move out of conversation state?                                     | It is routing state, not model state.                         | Dedicated store, conversation state with strict projection exclusion, or session log only. | Keep with strict projection exclusion until auth store consolidation.              | open   |
| Should reconnect-only flows auto-resume or confirm connection?                         | Eval allows connected confirmation.                           | Always resume, confirm only, or intent-sensitive.                                          | Intent-sensitive; define cases in eval taxonomy.                                   | open   |

## OpenSpec Requirements Draft

| Requirement                              | Scenarios                                                             | Source Evidence                 | Notes                         |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------- | ----------------------------- |
| Generic OAuth flow start                 | unsupported provider, missing client, no base URL, success, params    | oauth-flow code/tests, RFC 6749 | Server-side.                  |
| Private authorization link delivery      | channel, DM, fallback, failure, public ack                            | oauth-flow, Slack docs/tests    | URL-free.                     |
| Plugin auth pause orchestration          | explicit marker, auth text, disabled, reuse, record, park             | plugin auth code/tests          | Command failure path.         |
| MCP authorization orchestration          | provider, challenge, missing URL, reuse, record, disabled             | MCP auth code/tests, MCP docs   | SDK auth.                     |
| Callback validation and token storage    | unknown, error, missing, expired, mismatch, token success/fail, scope | callback/tests                  | Generic OAuth.                |
| MCP callback validation and finalization | state/error/code, valid, fail                                         | mcp callback/tests              | SDK-managed.                  |
| Authorization session-log events         | requested, completed, projection, no prompt flag                      | session-log/resumability        | User correction incorporated. |
| Pending-auth routing state               | reuse, current, stale, clear                                          | pending-auth/callback tests     | Not model state.              |
| Auth callback resume                     | awaiting, terminal, success, fail, re-pause, timeout                  | callbacks/resume tests          | Durable path.                 |
| Verification taxonomy                    | unit, integration, eval                                               | tests/evals                     | Layer map.                    |

## Migration Notes

- Canonical spec updates:
  - Existing `specs/oauth-flows.md` is already canonical prose; after review, consolidate with this OpenSpec capability.
  - Cross-link `authorization_requested`/`authorization_completed` to `agent-session-resumability`.
  - Keep private Slack message formatting details in Slack delivery/outbound specs.
- Index/pointer updates:
  - Already listed in `specs/index.md` and root `AGENTS.md`; add OpenSpec capability pointer after acceptance.
- Superseded content:
  - Remove any prompt-resume wording that suggests `pendingAuth` is model state.
- Test/eval taxonomy changes:
  - Keep callback validation in unit tests.
  - Keep Slack delivery/resume in integration tests.
  - Keep "resumed answer preserves context and continues original request" in evals.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-oauth-flows' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: state deletion retry semantics, stale-token-store completion event, public acknowledgement wording ownership, pendingAuth store location, reconnect-only flow scope.
