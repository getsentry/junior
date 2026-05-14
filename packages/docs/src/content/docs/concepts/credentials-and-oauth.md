---
title: Credentials & OAuth
description: Security model for scoped credentials and provider OAuth flows.
type: conceptual
prerequisites:
  - /concepts/execution-model/
related:
  - /extend/sentry-plugin/
  - /operate/security-hardening/
---

## Credential model

Junior does not preload provider access for an entire chat session. Registered
plugin providers are available to sandbox commands, and sandbox HTTP requests to
declared provider domains are forwarded through Junior. Junior then fetches a
requester-bound lease and injects auth at the host boundary.

- Credentials are short-lived and scoped to the requester, registered provider, and current sandbox command.
- User-owned provider access is only activated for the author of the current message.
- Plugin declarations determine which credentials can be injected for matching provider domains.
- Sandbox receives placeholder env vars and proxied HTTP responses, not raw long-lived tokens.
- Junior rejects proxied provider requests unless the sandbox command has an active requester-bound egress session and the forwarded host matches a registered provider domain.

## OAuth model

OAuth-based plugins keep the visible user flow simple while preserving per-user
authorization boundaries.

- Auth links are delivered privately to the requesting user.
- Token exchange occurs server-side and stores the grant per user and provider.
- OAuth completion resumes the blocked request path instead of asking the user to rerun the whole workflow.

## Operational invariants

- Normal plugin workflows rely on automatic credential injection, not manual credential commands.
- Never log raw token values.
- Never place secrets in skill files.
- Credential failures must surface clear operator-visible errors.

## Common failure classes

- `credential_unavailable` with OAuth required.
- stale/insufficient provider token access (401/403 post-issuance).
- provider misconfiguration (client ID/secret/redirect URL mismatch).

## Next step

- [Sentry Plugin](/extend/sentry-plugin/)
- [Security Hardening](/operate/security-hardening/)
