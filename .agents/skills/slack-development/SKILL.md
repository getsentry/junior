---
name: slack-development
description: Implement Slack bot behavior with correct Slack-documented message formats, inbound mention/event routing, and long-running task UX. Use when asked to "format Slack messages", "fix Slack markdown", "debug thread mentions", "improve Slack bot UX", "add streaming in Slack", or "build Slack Chat SDK behavior". Covers mrkdwn quirks, Events API payload patterns, routing guardrails, and Chat SDK implementation patterns.
---

Implement Slack-facing behavior with predictable formatting, inbound routing, and responsive long-running UX.

## Step 1: Classify the requested change

Determine which category applies before writing code:

| Category | Typical request | Primary reference |
| --- | --- | --- |
| Output formatting | "Fix markdown", "why does Slack render this weirdly?" | `${CLAUDE_SKILL_ROOT}/references/slack-output-formatting.md` |
| Slack event payloads | "What does Slack send?", "why did raw event parsing fail?" | `${CLAUDE_SKILL_ROOT}/references/slack-inbound-message-formats.md` |
| Chat SDK payload contract | "What fields do handlers actually receive?", "which fields are reliable in `onSubscribedMessage`?" | `${CLAUDE_SKILL_ROOT}/references/chat-sdk-payload-contract.md` |
| Thread routing | "Passive detector skips thread replies", "reply/no-reply logic is wrong" | `${CLAUDE_SKILL_ROOT}/references/slack-thread-routing.md` |
| Long-running behavior | "No feedback while it runs", "show progress", "stream output" | `${CLAUDE_SKILL_ROOT}/references/chat-sdk-patterns.md` |
| Multiple categories | Change touches formatting, routing, and/or runtime UX | Read only the needed references above |

If the request is ambiguous, ask one focused question and continue after clarification.

## Step 2: Load only relevant references and implement

Use the selected reference files as the implementation guide. Keep SKILL.md high-level and put details in references.

## Step 3: Enforce project conventions

When modifying this repository:

1. Keep tool behavior aligned with AI Gateway primitives already in use.
2. Avoid reintroducing deprecated custom search integrations when Gateway-native tools exist.
3. Preserve webhook `waitUntil` behavior so long-running handlers finish after HTTP response.

## Step 4: Validate before finalizing

Use this checklist:

- Rendering: message examples render correctly in Slack (`mrkdwn` expectations, escapes, mentions/links).
- Inbound formats: routing uses documented Chat SDK payload fields first; raw Slack parsing only when necessary.
- Thread routing: explicit bot mention paths bypass passive no-reply classification.
- Accessibility: block messages include an adequate top-level fallback `text` strategy.
- Latency UX: user sees immediate feedback for long-running tasks.
- Streaming/progress: behavior is observable during tool/model execution, not only at completion.
- Failure mode: errors return actionable responses rather than silent stalls.
