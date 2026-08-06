---
title: Credentials & OAuth
description: How Junior uses connected accounts without exposing secrets to the model or sandbox.
type: conceptual
summary: Understand actor-bound credentials, private OAuth, and task-scoped delegation.
prerequisites:
  - /concepts/security-and-authority/
related:
  - /concepts/tasks/
  - /extend/sentry-plugin/
  - /operate/security-hardening/
---

Credentials are one part of Junior's security model: how connected accounts get used without becoming ambient session power.

## Default rule

Junior does not preload provider access for a whole chat.

When sandbox traffic hits a registered provider domain, the host fetches a short-lived credential for the current authority and injects it at the proxy boundary.

- The sandbox sees placeholders and proxied responses, not long-lived tokens.
- Only registered plugin providers are eligible.
- Junior matches provider domains at request time. It does not guess from command text.
- Missing actor or subject context fails closed.

## Actor vs credential subject

| Role | Meaning |
| ---- | ------- |
| Actor | Who is driving the turn |
| Credential subject | Whose connected account may be used |

By default those are the same person: the author of the current message.

Later work can differ. Scheduled and event tasks often run as a system actor while optionally using the creator's connected account for that exact task. That is explicit delegation, not “Junior became you.”

## OAuth

When a user-bound grant is missing:

1. Junior stores a short-lived authorization request.
2. The auth link is delivered privately to the requesting user.
3. Token exchange happens on the server.
4. The blocked turn resumes after success.

Replayed, expired, or mismatched callbacks do nothing useful. Public channels should never receive reusable auth links.

## What users should expect

- Normal plugin work should not require pasting tokens into Slack.
- If access is missing or stale, Junior asks the right user to reconnect.
- Task runs can use creator credentials only when that was allowed for the task.
- Provider permissions still apply. Junior cannot invent access your account does not have.

## Common failures

- OAuth is required and has not been completed
- the connected account lacks permission for the target
- the plugin is missing or misconfigured
- the request went to a domain no registered provider owns

## Next step

See [Security & Authority](/concepts/security-and-authority/) for the broader model, or a concrete plugin page such as [Sentry Plugin](/extend/sentry-plugin/).
