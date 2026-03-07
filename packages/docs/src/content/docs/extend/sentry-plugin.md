---
title: Sentry Plugin
description: Configure Sentry OAuth for per-user investigation workflows.
type: tutorial
summary: Set up Sentry OAuth for per-user access and verify re-auth behavior for investigation workflows.
prerequisites:
  - /extend/plugins-overview/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Sentry plugin enables per-user OAuth so Slack users can run Sentry investigations through capability-scoped access.

## Setup

### Configure OAuth application

Set redirect URL to:

```text
<base-url>/api/oauth/callback/sentry
```

Set host env vars:

- `SENTRY_CLIENT_ID`
- `SENTRY_CLIENT_SECRET`

### Runtime auth flow

1. User runs `/sentry auth`.
2. Runtime sends private authorization link.
3. OAuth callback stores token and can resume the original request.

### Optional defaults

```bash
jr-rpc config set sentry.org getsentry
jr-rpc config set sentry.project my-project
```

## Verify

- `/sentry auth` completes successfully.
- A real query returns expected data.
- Re-auth flow works after token invalidation.

## Failure modes

- 401/403 after issuance: token lacks org access or stale token.
- Callback errors: redirect URL mismatch or invalid base URL.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
