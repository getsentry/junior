---
title: Security & Authority
description: How Junior decides who can act, what can run, and what stays blocked.
type: conceptual
summary: Understand the layers that keep Junior from acting with the wrong authority.
prerequisites:
  - /concepts/execution-model/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/conversations/
  - /operate/security-hardening/
---

Junior is useful because it can take action. That only works if authority is explicit.

Security here is not one switch. It is a few hard boundaries stacked together.

## What Junior keeps separate

| Concern | Meaning |
| ------- | ------- |
| Actor | Who is driving this turn |
| Destination | Where replies and side effects go |
| Credential subject | Whose connected account may be used |
| Conversation | The durable work and history container |

Being in a thread does not grant provider access. Creating a task does not make later runs act as you. Display names and channel membership are not identity.

If required context is missing, Junior fails closed.

## Hard gates first

Before anything fancy happens, Junior enforces boring rules:

- tool input must match the schema
- the active conversation, actor, and destination are fixed by the runtime
- only registered plugin providers can receive credentials
- secrets stay on the host, not in the model, sandbox env, files, logs, or traces
- user-influenced commands run in an isolated sandbox

These checks do not try to understand intent. They either pass or they block.

## Action review

Some actions also go through action review right before they run.

Junior builds an exact proposal from the validated tool input, then a separate reviewer called **Guardian** judges that proposal. Guardian can:

- **allow** the action
- **ask** the user to confirm the exact target and side effects
- **deny** the action

A few practical rules:

- core tools opt into review; external plugin and MCP tools are treated more carefully by default
- review sees the action about to run, not a vague plan
- prior rejections stay in play; retrying the same side effect with another tool does not dodge them
- if review is unavailable, the action does not run
- three rejected attempts in a row stop that execution slice

Guardian is a safety layer. It does not replace provider permissions, task ownership rules, or human judgment on consequential work.

## What this means in practice

- Ordinary reads and narrow requested work usually proceed.
- Surprising scope, destructive changes, sensitive data movement, or unclear authorization get blocked or asked about.
- Connected accounts are used only for the current actor, or for an explicit task-scoped delegation.
- Public channels are still real destinations. Do not paste secrets into them.
- Skills can explain how to do work. They cannot install packages, mint credentials, or widen access.

## Related pieces

- [Credentials & OAuth](/concepts/credentials-and-oauth/) covers connected accounts.
- [Conversations](/concepts/conversations/) covers who can see what.
- [Security Hardening](/operate/security-hardening/) is the operator checklist.
