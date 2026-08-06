---
title: Security Hardening
description: Operator checklist for Junior authentication, credentials, and incident response.
type: conceptual
summary: Verify production security boundaries after deployment or during an incident.
prerequisites:
  - /concepts/security-and-authority/
related:
  - /concepts/credentials-and-oauth/
  - /reference/config-and-env/
  - /operate/reliability-runbooks/
---

Use this checklist after deployment and when investigating a security issue. Read [Security & Authority](/concepts/security-and-authority/) for the product model.

## Runtime

- User-influenced commands run in the sandbox.
- Long-lived secrets stay in host-managed storage.
- The host adds provider credentials only when a request needs them.
- OAuth links are private to the requesting user.
- Internal callbacks and sandbox identity are signed with a stable `JUNIOR_SECRET`.
- Plugins come from explicit app configuration, not dependency scanning.

## Credentials

- Only domains registered by a plugin can receive provider credentials.
- The sandbox receives placeholders, not reusable tokens.
- User access belongs to the current user or an exact task delegation.
- Rotating `JUNIOR_SECRET` invalidates pending callbacks and sandbox identity signed with the old value.

## Action Review

- Consequential actions can still enter review.
- Review failure blocks the action.
- Guardian telemetry does not contain raw proposals or secrets.

## Data

- Private transcripts are hidden from non-participants.
- Logs and traces exclude tokens, prompts, raw messages, and credential material.
- Retention and purge settings match company policy.

## Incident Response

1. Check logs, traces, and user-visible output for exposed tokens.
2. Confirm OAuth links were private and bound to the requesting user.
3. Confirm credentials were used only for the expected user and provider.
4. Confirm the sandbox did not receive reusable secrets.
5. Rotate exposed credentials, remove leaked material, and document the fix.

## Next Step

Validate deployment settings in [Config & Environment](/reference/config-and-env/). Use [Reliability Runbooks](/operate/reliability-runbooks/) if the incident is still active.
