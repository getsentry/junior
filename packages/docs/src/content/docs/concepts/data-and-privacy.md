---
title: Data & Privacy
description: What Junior stores, who can see it, and what gets removed.
type: conceptual
summary: Understand what Junior retains and how conversation privacy is enforced.
prerequisites:
  - /concepts/conversations/
related:
  - /concepts/security-and-authority/
  - /operate/dashboard/
  - /operate/security-hardening/
---

Junior stores the data needed to continue work, deliver replies, and operate the product.

## Stored Data

| Data                    | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| Messages                | Transcript display, delivery, and search         |
| Agent history           | Continue turns across tools, pauses, and retries |
| Automations and watches | Run later or follow events                       |
| Artifacts               | Deliver files created during work                |
| Plugin records          | Support features from installed plugins          |

Sandbox files are temporary. Junior must persist or deliver a file before the sandbox disappears.

## Model Access

The model receives content selected for the active conversation, including the current thread, loaded skills, and tool results. Installed memory features may add content allowed for that actor and destination.

Junior uses normalized events instead of storing complete webhook payloads. Secret values and unrelated private conversations do not belong in model context.

## Visibility

The Slack destination controls conversation visibility. Child conversations, artifacts, and plugin records inherit the parent boundary.

- Work in one conversation can read and find public conversations in the same workspace.
- A private conversation is isolated. Work in another conversation never reads, finds, or messages it, also when you take part in both.
- Work in a private conversation never writes into a public one.
- In the dashboard, the people who take part in a private conversation can read it.

Read access does not grant permission to act with another user's connected account.

## Redaction and Retention

- **Redaction** hides sensitive content while preserving the record.
- **Expiry** removes content after its retention period.
- **Purge** removes the complete conversation tree.

Logs and traces use safe identifiers, counts, and error classes. They should not contain tokens, prompts, raw message bodies, or credential material.

## User Guidance

- Do not paste secrets, credentials, or private customer data into Slack.
- Link to approved systems instead of copying sensitive content.
- Treat public channels as public.

## Next Step

Use [Dashboard](/operate/dashboard/) for transcript access and [Security Hardening](/operate/security-hardening/) for production checks.
