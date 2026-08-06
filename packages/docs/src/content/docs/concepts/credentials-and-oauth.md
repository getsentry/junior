---
title: Credentials & OAuth
description: How Junior uses connected accounts without exposing secrets to the model or sandbox.
type: conceptual
summary: Understand connected accounts, private OAuth, and task-scoped access.
prerequisites:
  - /concepts/security-and-authority/
related:
  - /concepts/tasks/
  - /extend/sentry-plugin/
  - /operate/security-hardening/
---

Junior uses connected accounts only when a provider request needs them. It does not preload provider access for an entire conversation.

## Credential Handling

When sandbox traffic reaches a domain registered by a plugin, Junior fetches a short-lived credential and adds it at the host proxy.

- Long-lived tokens stay outside the model and sandbox.
- Only registered provider domains can receive credentials.
- Junior matches the request domain instead of guessing from command text.
- Missing identity or credential context blocks the request.

## User and Task Access

The current user is the default credential owner. Their account can be used only within the active turn and provider scope.

Scheduled and event tasks run as Junior, not as the creator. A task may use the creator's connected account when access was delegated to that exact task. The delegation does not apply to other tasks or conversations.

## OAuth

When a user needs to connect an account:

1. Junior sends that user a private, short-lived authorization link.
2. The provider returns the user to Junior after approval.
3. Junior stores the grant and resumes the blocked turn.

Authorization links are single-use and tied to the user, provider, and conversation. Expired, replayed, or mismatched callbacks are rejected.

## Common Failures

- the user has not completed OAuth
- the connected account cannot access the target
- the plugin or OAuth client is misconfigured
- no registered provider owns the request domain

Junior asks the user to reconnect when access is missing or stale. Users should never paste tokens into Slack.

## Next Step

Read [Security & Authority](/concepts/security-and-authority/) for the full security model, or configure a provider such as the [Sentry Plugin](/extend/sentry-plugin/).
