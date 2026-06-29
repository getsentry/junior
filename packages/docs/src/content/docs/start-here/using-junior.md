---
title: Using Junior
description: Practical guidance for asking Junior useful questions in Slack threads.
type: conceptual
summary: Write clearer Slack requests and keep Junior conversations easy for teammates to follow.
prerequisites: []
related:
  - /start-here/overview/
  - /concepts/thread-routing/
  - /start-here/verify-and-troubleshoot/
---

Junior works best when you treat each Slack thread as one focused work session. Give it the same context you would give a teammate who is joining the conversation late: what you want, where the work is happening, what changed, and what you have already tried.

This guide is written from Sentry's perspective. Adapt the channel names, escalation paths, privacy expectations, and review norms to match how your organization already works.

## Write a concrete request

Vague requests usually produce vague answers. Ask for a specific outcome and include the repo, environment, error, link, or decision you need Junior to use.

| Instead of                  | Ask this                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@jr fix this`              | `@jr in getsentry/junior, CI is failing on PR 482 in the docs check. Find the cause and propose the smallest patch.`                        |
| `@jr why is this broken?`   | `@jr this deploy started returning 500s after commit 9f4e2c. Compare the deploy diff with the top Sentry errors and recommend next action.` |
| `@jr make this better`      | `@jr review this onboarding doc for unclear steps. Keep the tone direct and suggest edits, but do not change setup commands.`               |
| `@jr look at the Slack bug` | `@jr the bot replies in DMs but not channel threads. Check the event path and tell me which Slack config or runtime path is wrong.`         |

If you know a boundary, say it upfront — tell Junior whether to only investigate, whether it can edit files, whether it should avoid committing, or whether it should wait before touching production settings. For risky or ambiguous work, ask it to lay out the plan before acting:

```
@jr this migration may touch production data.
Inspect the code and describe what you would do — do not run commands or open a PR until I say go.
```

## Use public threads by default

Ask in a public project or team channel when the work can be shared. Public threads are searchable, teammates can add missing context, and the final answer is visible to people who need the same fix later.

Use a DM only for private work. DM context stays private, so teammates cannot learn from the thread or carry that context into a later channel conversation. If you are not sure where to start, `#proj-junior` is a good place for Junior usage questions.

If you want a low-noise place for your own work, consider creating a public channel such as `#jr-<your-username>` instead of using DMs. You still get a persistent, shareable history, and teammates can join when a thread becomes relevant to them.

Do not paste secrets, private customer data, or credentials into any thread. Link to approved internal systems instead.

## Keep one task per thread

Thread history is part of the context Junior uses to decide what to do next. Switching topics in the same thread makes the model reason over stale assumptions and unrelated decisions.

Start a new thread when the goal changes:

- Use the same thread for follow-up questions about the same bug, PR, deploy, or decision.
- Start a new thread for a different repo, a different incident, or a new implementation request.
- If Junior misunderstood the task, correct it in the same thread and restate the target outcome.

## Mention Junior when starting

Mention `@jr` when you want Junior to join a channel thread. After Junior has replied in that thread, follow-up replies in the same thread do not need another mention.

In DMs, send the request directly. In shared channels, prefer a thread over a top-level back-and-forth so the work stays grouped with the original context.

## Steering Junior

Junior reads every message in the thread, so you can course-correct at any point without starting over. Reply with plain language to redirect, narrow scope, stop the current task, or adjust how much detail you want:

- **Redirect:** `@jr focus on the worker path only, not the whole queue`
- **Stop:** `@jr stop — I meant staging, not prod`
- **Narrow scope:** `@jr skip the frontend, just fix the query`
- **Verbosity:** `@jr tl;dr` or `@jr more detail on the error handling`

Junior cannot undo side effects that have already landed — a pushed commit, a filed issue, a sent Slack message. Redirect before the action, not after.

## Verify important output

Junior is still an LLM-backed agent. It reasons from the context it can see, tool results it can access, and instructions you give it. It can miss details or make a bad call when context is incomplete.

For consequential work, verify the result before acting:

- Review code changes before merging.
- Check production-impacting commands before approving them.
- Confirm links, numbers, and summaries against the source system.
- Rephrase and retry when the answer is off target.

You usually get a better second answer by adding the missing constraint directly: `Focus on the queue worker path, not Slack config`, or `Do not change the API shape; only update docs`.

## Next step

Read [Thread Routing](/concepts/thread-routing/) to understand how Junior decides whether to answer in Slack, or return to the [Overview](/start-here/overview/) for setup and operations docs.
