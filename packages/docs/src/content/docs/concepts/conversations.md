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

A **conversation** is Junior's durable unit of work. In Slack, one conversation usually maps to one thread.

## Conversations and Turns

A conversation contains messages, execution state, and the history needed to continue work. A **turn** starts with a request and ends with a reply, an intentional no-reply, or a failure.

A turn may pause and resume without starting a new conversation. Junior can also shorten its working history to fit the available context without changing the Slack transcript.

## Status

Each conversation has one status. It comes from what Junior runs, never from the reply text, and it covers only that conversation's own work, not its child agents.

| Status        | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `active`      | A turn runs or waits to start.                                                         |
| `stopped`     | A person or a parent agent stopped it.                                                 |
| `failed`      | Its latest turn failed.                                                                |
| `needs_input` | An action Review item that it added waits for an answer.                               |
| `idle`        | It waits for a message. A turn that waits for sign-in or ends in a question is `idle`. |

When more than one applies, the first in the table wins. Archive does not change the status.

## Slack Behavior

- Mention Junior to start work in a channel thread.
- Follow-ups stay in the same conversation after Junior joins.
- Replies return to the same thread.
- Keep one task per thread. Start a new thread when the goal changes.
- Use public channels for shareable work and DMs for private work.

Messages are processed in order. A new mention can steer active work at the next safe point. Other messages wait for the current turn to finish.

## Visibility

Conversation privacy follows its Slack destination:

- public channels follow workspace and dashboard access rules
- private channels and DMs stay private
- missing visibility is treated as private

Child work, generated files, and plugin records inherit the conversation's visibility. Transcript access does not grant connected-account access or task ownership.

## Context

Junior uses the current thread, selected skills and files, and results from the active work. It never reads other private conversations. See [Data & Privacy](/concepts/data-and-privacy/#visibility).

An installed Memory plugin may add scoped recall. It does not provide unrestricted access to every conversation.

## Next Step

Read [Execution Model](/concepts/execution-model/) for pauses and retries, or [Data & Privacy](/concepts/data-and-privacy/) for storage and access rules.
