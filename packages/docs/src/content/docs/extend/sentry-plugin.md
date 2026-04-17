---
title: Sentry Plugin
description: Configure Sentry OAuth for per-user investigation workflows.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Sentry plugin enables per-user OAuth so Slack users can run Sentry investigations with their own access.
Junior stores the Sentry grant server-side and only activates it during that
same user's turn when a Sentry command actually needs auth.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-sentry
```

## Runtime setup

List the plugin in `juniorNitro({ pluginPackages: [...] })`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-sentry"],
});
```

## Configure environment variables

Set these values in the host environment:

| Variable               | Required | Purpose              |
| ---------------------- | -------- | -------------------- |
| `SENTRY_CLIENT_ID`     | Yes      | OAuth client ID.     |
| `SENTRY_CLIENT_SECRET` | Yes      | OAuth client secret. |

## Create the Sentry OAuth application

Create an OAuth application in Sentry and set its redirect URL to:

```text
<base-url>/api/oauth/callback/sentry
```

Then copy the client ID and client secret into your deployment environment as `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET`.

Junior requests these Sentry OAuth scopes:

- `event:read`
- `org:read`
- `project:read`
- `team:read`

## Verify

Run the auth flow and then make a real Sentry request:

1. User asks Junior to connect Sentry for their account.
2. Junior sends the private authorization link.
3. The OAuth callback stores the token and resumes the original request.
4. User runs a real Sentry query in Slack, naming the org and project explicitly if the workspace spans multiple targets.

Confirm the auth flow completes, the query returns expected data, and re-auth works after token invalidation.

## Security model

- The real Sentry token stays in host-managed storage and is never printed back to the model.
- Junior injects Sentry auth only for the requesting user's turn.
- Missing or stale auth triggers a private reconnect flow and resumes the blocked request after consent.

## Failure modes

- Callback errors after consent: the OAuth redirect URL does not exactly match `<base-url>/api/oauth/callback/sentry`. Update the OAuth app redirect URL and retry.
- `401` after authorization: the stored token is stale or revoked. Reconnect Sentry and retry.
- Explicit `missing scope` or `insufficient scope` after authorization: reconnect Sentry to refresh the stored grant, then retry.
- Generic `403` after authorization: the connected account lacks access to the target org or project. Reconnect with an account that can access the target org, or change the request target.
- Auth link points at the wrong host: `JUNIOR_BASE_URL` is unset or incorrect. Set it to the canonical public base URL used for callbacks.
- Query still targets the wrong org or project: Junior does not have enough target context for this request. Include the org and project directly in the Sentry request and retry.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
