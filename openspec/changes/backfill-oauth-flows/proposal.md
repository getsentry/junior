# Backfill `oauth-flows`

## Why

Junior has two authorization paths that park and resume Slack turns: generic plugin OAuth for provider HTTP credentials and MCP OAuth for remote MCP servers. Both must keep links private, keep tokens host-side, represent authorization completion in session history, and resume only the still-relevant blocked request. The current implementation and prose spec already contain much of this model, including the newer session-log interrupt approach, but it needs a baseline OpenSpec capability with researched requirements and explicit open questions.

## What Changes

- Add an OpenSpec capability for `oauth-flows`.
- Specify generic plugin OAuth start/callback, MCP auth challenge/callback, private link delivery, state/session stores, pending-auth dedupe/routing, session-log auth events, callback resume gating, token storage, and failure pages.
- Incorporate the auth-resume boundary: authorization is a session-log event projected into Pi on resume, not a prompt flag.
- Record prior art from OAuth 2.0 authorization code/refresh flows, MCP HTTP authorization, Slack private/ephemeral delivery constraints, and host-controlled agent permission gates.

## Impact

- Affected specs:
  - `credential-injection`
  - `agent-session-resumability`
  - `slack-agent-delivery`
  - `slack-outbound-contract`
  - `mcp-tool-runtime`
  - `plugin-runtime`
  - `security-policy`
  - `eval-testing`
- Affected code evidence:
  - `specs/oauth-flows.md`
  - `packages/junior/src/chat/oauth-flow.ts`
  - `packages/junior/src/handlers/oauth-callback.ts`
  - `packages/junior/src/handlers/mcp-oauth-callback.ts`
  - `packages/junior/src/chat/services/plugin-auth-orchestration.ts`
  - `packages/junior/src/chat/services/mcp-auth-orchestration.ts`
  - `packages/junior/src/chat/mcp/oauth.ts`
  - `packages/junior/src/chat/mcp/auth-store.ts`
  - `packages/junior/src/chat/state/session-log.ts`
- Affected verification:
  - Unit tests for state validation, callback error pages, broker token parsing, auth orchestration, MCP auth store/provider, and stale callback handling.
  - Slack/runtime integration tests for private delivery, URL-free public acknowledgement, session-log auth events, same-thread resume, and stale/newer-thread suppression.
  - Evals for provider workflows that pause, complete, and resume without losing context.
