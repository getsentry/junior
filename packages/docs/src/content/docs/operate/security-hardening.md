---
title: Security Hardening
description: Runtime security model, credential boundaries, and incident checks.
type: conceptual
summary: Apply core runtime security boundaries, credential controls, and incident checks for Junior deployments.
prerequisites:
  - /concepts/credentials-and-oauth/
related:
  - /reference/config-and-env/
  - /operate/reliability-runbooks/
---

## Runtime boundaries

- User-influenced command execution runs in sandboxed environments.
- Harness/runtime resolves target context, not model-selected destinations.
- Credential issuing and sandbox command execution are separate trust boundaries.

## Credential handling

- Use short-lived scoped credentials.
- Issue credentials only with explicit capability checks.
- Inject scoped auth at host boundary instead of exposing raw tokens.

## OAuth handling

- Deliver auth links privately to requesting users.
- Keep token exchange server-side.
- Store tokens per user/provider scope.

## Incident checklist

1. Confirm no token values in logs/traces/output.
2. Confirm OAuth links were not publicly posted.
3. Confirm credential issuance failures map to expected events.
4. Confirm sandbox session never received raw auth secrets.

## Next step

Continue with [Config & Environment](/reference/config-and-env/) to validate deployment defaults, then use [Reliability Runbooks](/operate/reliability-runbooks/) for incident response.
