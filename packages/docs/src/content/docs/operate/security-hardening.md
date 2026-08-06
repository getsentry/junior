---
title: Security Hardening
description: Operator checklist for Junior auth boundaries, credentials, and incident checks.
type: conceptual
summary: Verify production security boundaries after deploy or during an incident.
prerequisites:
  - /concepts/security-and-authority/
related:
  - /concepts/credentials-and-oauth/
  - /reference/config-and-env/
  - /operate/reliability-runbooks/
---

Use this page as an operator checklist. For the product model behind it, start with [Security & Authority](/concepts/security-and-authority/).

## Runtime boundaries

Confirm these are still true in the deployed app:

- user-influenced commands run in the sandbox
- long-lived secrets stay in host-managed storage
- provider credentials are minted lazily at egress, not loaded into the whole chat session
- OAuth links are private to the requesting user
- internal callbacks and sandbox actor context are signed with a stable `JUNIOR_SECRET`
- plugins come from explicit app configuration, not dependency scanning

## Credential checks

- Registered plugin providers own which domains can receive credentials.
- Sandbox traffic gets placeholders, not raw reusable tokens.
- User-bound access belongs to the current actor or an explicit task-scoped subject.
- Rotating `JUNIOR_SECRET` invalidates old signed callbacks and sandbox actor context.

## Action review checks

- consequential tool actions can still enter review
- review failure blocks the action instead of failing open
- Guardian or action-review telemetry does not log raw proposal bodies or secrets

## Data checks

- private transcripts are not exposed to non-participants in the dashboard
- logs and traces do not contain tokens, prompts, raw message bodies, or credential material
- retention and purge still match the intended policy

## Incident checklist

1. Confirm no token values landed in logs, traces, or user-visible output.
2. Confirm OAuth links were private and bound to the requesting user.
3. Confirm credential injection happened only for the expected actor and provider.
4. Confirm the sandbox session never received raw long-lived secrets.
5. Rotate exposed credentials, remove leaked material, and document the fix.

## Next step

Validate deployment defaults in [Config & Environment](/reference/config-and-env/), then use [Reliability Runbooks](/operate/reliability-runbooks/) if the incident is still active.
