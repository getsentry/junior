---
name: slack-development
description: Implement Slack bot behavior with correct Slack-documented message formats, inbound mention/event routing, and long-running task UX. Use when asked to "format Slack messages", "fix Slack markdown", "debug thread mentions", "improve Slack bot UX", "add streaming in Slack", or "build Slack Chat SDK behavior". Covers mrkdwn quirks, Events API payload patterns, routing guardrails, and Chat SDK implementation patterns.
---

Implement Slack-facing behavior with predictable formatting, inbound routing, and responsive long-running UX.

## Step 1: Classify the requested change

Determine which category applies before writing code:

| Category                  | Typical request                                                                                                                                 | Primary reference                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output formatting         | "Fix markdown", "why does Slack render this weirdly?"                                                                                           | `${CLAUDE_SKILL_ROOT}/references/slack-output-formatting.md`                                                                                                                                                |
| Slack event payloads      | "What does Slack send?", "why did raw event parsing fail?"                                                                                      | `${CLAUDE_SKILL_ROOT}/references/slack-inbound-message-formats.md`                                                                                                                                          |
| Chat SDK payload contract | "What fields do handlers actually receive?", "which fields are reliable in `onSubscribedMessage`?"                                              | `${CLAUDE_SKILL_ROOT}/references/chat-sdk-payload-contract.md`                                                                                                                                              |
| Thread routing            | "Passive detector skips thread replies", "reply/no-reply logic is wrong"                                                                        | `${CLAUDE_SKILL_ROOT}/references/slack-thread-routing.md`                                                                                                                                                   |
| Assistant-thread APIs     | "Why does `assistant.threads.setStatus` fail?", "should this DM have assistant status/title?", "does Chat tab DM count as an assistant thread?" | Read Slack docs for `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`, and `assistant.threads.*` first, then load `${CLAUDE_SKILL_ROOT}/references/chat-sdk-payload-contract.md` |
| Long-running behavior     | "No feedback while it runs", "show progress", "stream output"                                                                                   | `${CLAUDE_SKILL_ROOT}/references/chat-sdk-patterns.md`                                                                                                                                                      |
| Multiple categories       | Change touches formatting, routing, and/or runtime UX                                                                                           | Read only the needed references above                                                                                                                                                                       |

If the request is ambiguous, ask one focused question and continue after clarification.

## Step 2: Load only relevant references and implement

Use the selected reference files as the implementation guide. Keep SKILL.md high-level and put details in references.

Slack assistant-thread guardrails:

1. Use Slack's current inbound event payload as the source of truth for assistant-thread API calls. For `message.im`, require the live `channel` and explicit `thread_ts`. For lifecycle events, use `assistant_thread.channel_id` and `assistant_thread.thread_ts`.
2. Do not invent assistant-thread identifiers from persisted state unless Slack's docs explicitly require it.
3. Separate reply continuity from assistant-thread API eligibility. A stored root timestamp can be valid for reply threading without being valid for `assistant.threads.*`.
4. Treat `assistant_thread_started` and `assistant_thread_context_changed` differently. Context changes can refresh prompts/context, but should not clobber a conversation-specific thread title back to a generic default.
5. Conversation-specific thread titles should come from the earliest human message the runtime actually knows about for that thread, using the lightweight title model. Do not base titles on assistant reply text or a later follow-up.
6. Title generation may run in parallel with the main assistant turn, but it must not delay assistant reply generation or visible reply delivery.
7. Assistant status is best effort. Do not make Slack status writes part of the critical path for tool/model execution.
8. If debugging a live repro through the example app, verify whether the app is executing `packages/junior/dist/*` output before trusting source edits against runtime behavior.

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
- Assistant threads: `assistant.threads.*` calls use the live inbound assistant-thread context; `message.im` must carry explicit `thread_ts`, and runtime code does not synthesize assistant roots for status/title updates.
- Accessibility: block messages include an adequate top-level fallback `text` strategy.
- Latency UX: user sees immediate feedback for long-running tasks.
- Streaming/progress: behavior is observable during tool/model execution, not only at completion.
- Failure mode: errors return actionable responses rather than silent stalls.
