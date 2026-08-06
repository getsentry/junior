---
title: Data & Privacy
description: What Junior stores, who can see it, and what gets removed.
type: conceptual
summary: Know what Junior retains, what the model can see, and how privacy is enforced.
prerequisites:
  - /concepts/conversations/
related:
  - /concepts/security-and-authority/
  - /operate/dashboard/
  - /operate/security-hardening/
---

Junior keeps enough state to finish work, show a transcript, and operate the product. It should not keep more than that.

## What gets stored

| Kind | Why it exists |
| ---- | ------------- |
| Messages | Exact chat content for transcripts, delivery, and search |
| Agent history | Model inputs, tool calls, and tool results needed to continue a turn |
| Tasks and watches | Durable later work and temporary event follows |
| Artifacts | Files Junior intentionally prepares to share |
| Plugin records | Feature data owned by an installed plugin |

Sandbox files are temporary workspace state. They are not product storage. If something matters, Junior has to persist or deliver it on purpose.

## What the model can see

The model only gets content authorized for the active conversation and actor. That usually means:

- the current thread
- selected skills and runtime instructions
- tool results from the current work
- any installed memory feature that is allowed to recall into this conversation

It should not receive raw provider webhook payloads, other users' private transcripts, or secret values.

## Visibility and access

- Destination visibility is the privacy authority.
- Private conversations stay private in the dashboard unless you are an authorized participant.
- Public conversation metadata may be broader than private transcript access.
- Child conversations and plugin records inherit the parent boundary.

Read access is not the same thing as the right to act. Dashboard viewers do not automatically get connected-account authority.

## Redaction, expiry, and purge

These are different:

- **Redaction** keeps a record without exposing sensitive content.
- **Expiry** removes retained content after the retention window.
- **Purge** deletes a conversation tree when it is time to fully remove it.

Logs and traces should carry ids, counts, and safe error classes. They should not carry prompts, tokens, raw message bodies, or credential material.

## Practical rules

- Do not paste secrets, credentials, or private customer data into Slack.
- Prefer links to approved systems over copied sensitive content.
- Treat public channels as public.
- Review anything consequential before you rely on it.

## Next step

Use [Dashboard](/operate/dashboard/) for transcript and task access, then [Security Hardening](/operate/security-hardening/) for operator checks.
