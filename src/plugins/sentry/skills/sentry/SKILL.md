---
name: sentry
description: Query Sentry telemetry (issues, events, replays, traces) and generate deep links scoped to users or timeframes. This skill should be used when users ask to investigate bugs, search errors, find replays, or look up Sentry data via /sentry.
requires-capabilities: sentry.api
uses-config: sentry.org sentry.project
allowed-tools: bash
---

# Sentry Operations

Use this skill for `/sentry` workflows in the harness.

## Workflow

1. Confirm operation and target:
- Determine operation: `auth`, `disconnect`, `issue list`, `issue explain`, `issue plan`, `replays`, `deep-link`, or general query.
- If `auth` or `disconnect`, handle OAuth flow (see below) and stop.
- Resolve org from channel config: `jr-rpc config get sentry.org`
- Resolve project from channel config: `jr-rpc config get sentry.project` (optional — many queries span multiple projects).
- If org is missing and needed, ask the user.

2. Enable credentials:
- Before any authenticated Sentry operation, run: `jr-rpc issue-credential sentry.api`
- Sandbox runtime applies scoped Authorization headers for this turn.
- Do not pass raw tokens into the sandbox.
- If credential issuance fails with `credential_unavailable` + `oauth_started`, relay the `message` from the result to the user and **stop the turn** — the callback will automatically resume the request after they authorize.
- If a Sentry API call returns 401 or 403 after credentials were issued, the user's token may lack access for the requested org. Run `jr-rpc delete-token sentry` to clear the stale token, then run `jr-rpc issue-credential sentry.api` again to trigger a fresh OAuth flow. Do not ask the user to run a command manually — the system handles re-authorization automatically.

3. Execute via CLI:
- Use `npx @sentry/cli <command>` for structured queries.
- The CLI reads `SENTRY_AUTH_TOKEN` from env (injected by broker via lease env field).
- Read [references/cli-commands.md](references/cli-commands.md) for command shapes and flags.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) before relying on sandbox credentials.

4. Generate deep links:
- For user-scoped or entity-specific views, generate URLs instead of CLI calls.
- Read [references/deep-link-patterns.md](references/deep-link-patterns.md) for URL templates.

5. Report result:
- Return issue details, replay links, deep links, or CLI output inline.
- Include Sentry web URLs for easy navigation.

## Auth flow

When user runs `/sentry auth`:
1. Run: `jr-rpc oauth-start sentry`
   - The command sends the authorization link privately (visible only to the requesting user) and returns `{ ok, private_delivery_sent: true }`.
   - If `private_delivery_sent` is false, tell the user to send you a direct message and try again. **Never** post or relay authorization URLs — they are security-sensitive.
2. Tell the user you've sent them a private authorization link.
3. Stop. The agent turn ends here. When the user completes authorization in their browser, the callback handler stores tokens and posts a confirmation message back into the thread automatically.

When user runs `/sentry disconnect`:
- Clear stored tokens: `jr-rpc delete-token sentry` and post confirmation.

## Guardrails

- Read-only operations only (MVP scope).
- Do not print credential values.
- If org is missing and needed, ask the user.
- Prefer deep links over raw data dumps when linking to Sentry web UI.
