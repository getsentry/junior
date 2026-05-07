---
title: Security Hardening
description: Runtime security model, credential boundaries, and incident checks.
type: conceptual
prerequisites:
  - /concepts/credentials-and-oauth/
related:
  - /reference/config-and-env/
  - /operate/reliability-runbooks/
---

## Runtime boundaries

Automatic auth does not make credentials ambient. Junior still keeps command
execution, credential minting, and OAuth state handling in separate trust
boundaries.

- User-influenced command execution runs in sandboxed environments.
- Harness/runtime resolves target context and decides whether a command receives credentials.
- Credential minting and sandbox command execution stay separate even when injection is automatic.

## Credential handling

Operators should assume provider access is fetched just in time, not kept as
session-wide sandbox state.

- Use short-lived scoped credentials.
- Let loaded skills and their plugin capabilities determine which credentials may be injected.
- Fetch credentials per authenticated command and keep them bound to the requesting turn.
- Inject scoped auth at host boundary instead of exposing raw tokens.

## OAuth handling

- Deliver auth links privately to requesting users.
- Keep token exchange server-side.
- Store tokens per user/provider scope and resume the blocked request after authorization.

## Incident checklist

1. Confirm no token values in logs/traces/output.
2. Confirm OAuth links were not publicly posted and the callback state matched the requesting user.
3. Confirm credential injection happened only for the expected turn and target.
4. Confirm sandbox session never received raw auth secrets or reusable long-lived tokens.

## Next step

Continue with [Config & Environment](/reference/config-and-env/) to validate deployment defaults, then use [Reliability Runbooks](/operate/reliability-runbooks/) for incident response.
