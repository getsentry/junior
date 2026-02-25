---
name: slack-development
description: Implement Slack bot behavior with correct formatting, messaging, and long-running task UX. Use when asked to "format Slack messages", "fix Slack markdown", "improve Slack bot UX", "add streaming in Slack", "handle long-running Slack tasks", or "build Slack Chat SDK behavior". Covers mrkdwn quirks, accessibility requirements, and Chat SDK implementation patterns.
---

Implement Slack-facing behavior with correct formatting and responsive long-running UX.

## Step 1: Classify the requested change

Determine which category applies before writing code:

| Category | Typical request | Primary reference |
| --- | --- | --- |
| Message formatting | "Fix markdown", "why does Slack render this weirdly?" | `${CLAUDE_SKILL_ROOT}/references/slack-formatting.md` |
| Long-running behavior | "No feedback while it runs", "show progress" | `${CLAUDE_SKILL_ROOT}/references/chat-sdk-patterns.md` |
| Both | Any implementation touching rendering and runtime UX | Read both references |

If the request is ambiguous, ask one focused question and continue after clarification.

## Step 2: Apply formatting rules

When implementing or reviewing Slack message output:

1. Treat Slack formatting as `mrkdwn`, not CommonMark.
2. Escape only control characters in dynamic text: `&`, `<`, `>`.
3. Use explicit `\n` for line breaks and bullet-style list text (`- item`) instead of assuming Markdown list parsing.
4. Use canonical Slack entity syntax for links/mentions/channels/dates when structured behavior is required.
5. When posting blocks, ensure top-level fallback `text` remains accessible and meaningful.

For syntax details and examples, read `${CLAUDE_SKILL_ROOT}/references/slack-formatting.md`.

## Step 3: Implement long-running task feedback

For operations that may exceed a few seconds:

1. Acknowledge quickly (typing indicator or short immediate status message).
2. Prefer streaming final output instead of waiting for a single terminal response.
3. Surface phase transitions ("searching", "analyzing", "drafting") when tool-heavy steps run.
4. If streaming is unavailable for a path, post periodic status updates with clear state transitions.
5. On failure, post a concise failure state with the next action the user can take.

For concrete code patterns, read `${CLAUDE_SKILL_ROOT}/references/chat-sdk-patterns.md`.

## Step 4: Enforce project conventions

When modifying this repository:

1. Keep tool behavior aligned with AI Gateway primitives already in use.
2. Avoid reintroducing deprecated custom search integrations when Gateway-native tools exist.
3. Preserve webhook `waitUntil` behavior so long-running handlers finish after HTTP response.

## Step 5: Validate before finalizing

Use this checklist:

- Rendering: message examples render correctly in Slack (`mrkdwn` expectations, escapes, mentions/links).
- Accessibility: block messages include an adequate top-level fallback `text` strategy.
- Latency UX: user sees immediate feedback for long-running tasks.
- Streaming/progress: behavior is observable during tool/model execution, not only at completion.
- Failure mode: errors return actionable responses rather than silent stalls.

