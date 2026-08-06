---
title: Conversations
description: How Junior groups work, keeps context, and decides who can see it.
type: conceptual
summary: Understand conversations, turns, visibility, and Slack thread behavior.
prerequisites:
  - /start-here/using-junior/
related:
  - /concepts/execution-model/
  - /concepts/security-and-authority/
  - /concepts/data-and-privacy/
---

A **conversation** is Junior's durable unit of work. In Slack, that usually maps to one thread. The thread is the place people talk. The conversation is what Junior stores, resumes, and authorizes against.

## The pieces that matter

| Term | What it is |
| ---- | ---------- |
| Conversation | Durable history and execution state |
| Turn | One request through to a finished response |
| Actor | Who is driving the current work |
| Destination | Where Junior is allowed to reply |
| Message | Exact chat content people can see |
| Agent history | What the model uses to continue the work |

Visible messages and model history are related, but they are not the same thing. Junior can summarize or replace model history without rewriting the Slack transcript.

## Slack behavior

- Mention Junior to start work in a channel thread.
- After Junior has joined, follow-ups in that thread stay in the same conversation.
- Replies go back to the same thread, not a new top-level message.
- Keep one task per thread. Start a new thread when the goal changes.
- Use public channels for shareable work. Use DMs for private work.

Incoming work is ordered per conversation. A mention can interrupt at the next safe boundary. Other messages wait their turn.

## Visibility

Conversation privacy follows the destination:

- public channels are visible according to your workspace norms and dashboard access rules
- private channels and DMs stay private
- unknown or missing visibility stays private

Child work created under a conversation inherits that boundary. Being able to read a transcript does not grant provider credentials or the right to delete someone else's tasks.

## What stays in context

Junior continues from:

- the current thread
- the active actor and destination
- tools, skills, and files selected for the turn
- any compacted summary needed to keep the work moving

It does not silently pull in private context from unrelated conversations. If a Memory plugin is installed, that is a separate scoped feature, not ambient access to everything.

## Next step

Read [Execution Model](/concepts/execution-model/) for how a turn survives pauses and retries, or [Data & Privacy](/concepts/data-and-privacy/) for what is stored and redacted.
