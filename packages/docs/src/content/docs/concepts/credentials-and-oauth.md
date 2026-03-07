---
title: Credentials & OAuth
description: Security model for scoped credentials and provider OAuth flows.
type: conceptual
summary: Learn how capability-scoped credentials and OAuth flows protect provider access in Junior.
prerequisites:
  - /concepts/execution-model/
related:
  - /extend/sentry-plugin/
  - /operate/security-hardening/
---

## Credential model

- Credentials are short-lived and scoped by capability.
- Issuance requires requester context.
- Sandbox receives scoped header injection, not raw long-lived tokens.

## OAuth model

- Auth links are delivered privately to the requesting user.
- Token exchange occurs server-side.
- OAuth completion can resume the original request path.

## Operational invariants

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
