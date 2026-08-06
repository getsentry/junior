---
title: Security & Authority
description: How Junior decides who can act, what can run, and what stays blocked.
type: conceptual
summary: Understand how Junior limits actions, credentials, and data access.
prerequisites:
  - /concepts/execution-model/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/conversations/
  - /operate/security-hardening/
---

Junior can read data and take action through connected tools. Its security model limits which actions can run, whose account can be used, and where results go.

## Security Boundaries

| Boundary | How it works |
| -------- | ------------ |
| Identity | The current user drives the turn. Thread history, display names, and channel membership do not grant access. |
| Destination | Replies and files stay bound to the active conversation. |
| Credentials | Provider access is short-lived and belongs to the current user or an exact task delegation. |
| Execution | User-influenced commands run in an isolated sandbox. Long-lived secrets stay on the host. |
| Capabilities | Junior loads only the plugins configured by the app operator. Skills cannot add credentials or runtime access. |

Junior rejects work when required identity or destination context is missing.

## Action Review

Some actions are reviewed immediately before they run. A separate reviewer called **Guardian** checks the exact action against the user's request and the active security context.

Guardian can:

- allow the action
- ask the user to confirm its target and side effects
- deny the action

Guardian receives relevant conversation context and a description of the available account access. It does not receive credential values. A rejected action cannot bypass review by switching tools, and the action stays blocked if review is unavailable.

Action review checks risk and user authorization. It works alongside fixed controls such as provider permissions, tool validation, task ownership, and credential scope.

## Limits

- Provider permissions still apply. Junior cannot create access the connected account does not have.
- Plugins run as trusted application code. Review plugin code and manifests before enabling them.
- A sandbox limits command execution, but it is not durable storage.
- Do not put secrets or private customer data in Slack messages.
- Review consequential changes before merging or deploying them.

## Next Step

Read [Credentials & OAuth](/concepts/credentials-and-oauth/) for connected accounts. Operators should also review [Security Hardening](/operate/security-hardening/).
