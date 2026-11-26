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

Each conversation has one status. It comes from what Junior runs, never from the reply text, and it covers only that conversation's own work, not its child agents. Each person also gets a [viewer state](#viewer-state) that includes the child agents.

| Status        | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `needs_input` | It waits on a person: an open action Inbox item that it added, a sign-in, or its starter (see below).      |
| `working`     | A turn runs or waits to start.                                                                              |
| `done`        | Anything else, such as a finished answer that its starter read, a stopped conversation, or an idle one.     |

It waits on its starter, the person who started it, when its latest turn failed or the starter has not read its latest answer. An answer counts as read once Junior posts it in Slack, once the starter sends a later message, or once the starter reads it in the dashboard. A running turn is `working`, not waiting on its starter.

When more than one applies, the first in the table wins, so a conversation with an open action Inbox item reads `needs_input` while a turn runs. Archive does not change the status.

## Viewer State

A conversation can start child agents, and they can start their own. The status of the conversation does not show their work. For example, a conversation whose child agent still runs can read `done`. The status is also the same for everyone, so it does not tell you whether a wait is on you.

The **viewer state** covers the conversation and all of its child agents, and it is different for each person who looks at it. The dashboard shows it, and the MCP tools return it as `treeState`:

| Viewer state | Icon          | Meaning                                                                                                        |
| ----------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `needs_you` | Question mark | A conversation in the tree waits on you: an Inbox item for you or for everyone, a sign-in that you must do, or an unread answer or a failed turn in work that you started. |
| `working`   | Spinner       | A turn runs or waits to start anywhere in the tree.                                                            |
| `done`      | None          | Anything else.                                                                                                 |

A wait on the starter counts only for the starter, and it counts for each conversation above the one that waits. For example, a failed Thread shows `needs_you` to its starter on the Thread and on its Lead. Input that waits on another person does not show as `needs_you` for you. Archived child agents do not count. When more than one state applies, the first in the table wins.

A separate `watching` flag is true when a conversation in the tree watches for an event or has a pending timer. The dashboard shows it as an eye icon when the tree is otherwise `done`. A watch is not work, so it does not change the status or make the tree `working`.

## Slack Behavior

- Mention Junior to start work in a channel thread.
- Follow-ups stay in the same conversation after Junior joins.
- Replies return to the same thread.
- Keep one task per thread. Start a new thread when the goal changes.
- Use public channels for shareable work and DMs for private work.

Messages are processed in order. A new message from a person is a new instruction, and it steers active work at the next safe point. Other input, such as Events, waits for the current turn to finish.

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
