---
title: Execution Model
description: How Junior turns a request into durable work and a reply.
type: conceptual
summary: Understand how Junior accepts work and survives pauses or retries.
prerequisites:
  - /start-here/using-junior/
related:
  - /concepts/conversations/
  - /concepts/security-and-authority/
  - /concepts/tasks/
---

Junior stores work before processing it. This lets a turn continue after a timeout, authorization prompt, or worker restart.

## How work moves through Junior

1. A Slack message, task, or plugin event arrives.
2. Junior validates and stores the work.
3. A worker starts or resumes the conversation's active turn.
4. The turn uses tools, skills, and sandbox commands as needed.
5. Completed replies return to the original destination.
6. Paused work resumes from its latest safe checkpoint.

Queue messages only wake a worker. Stored conversation state remains the source of truth.

## Turns and Ordering

A **turn** covers one request through its final outcome. It may span several bounded attempts while keeping the same conversation and turn identity.

Only one worker owns a conversation at a time. New mentions can steer active work at a safe point. Other messages wait for the current turn to finish.

Progress updates are status, not final replies. Text produced while calling tools stays internal until Junior produces a reply.

## Recovery

Junior saves completed tool work. It resumes from the latest saved state when:

- OAuth pauses a turn
- work exceeds one execution window
- a worker stops unexpectedly
- delivery fails and can be retried

Sandbox files are temporary. They may disappear between attempts.

## Delivery Guarantees

- Accepted work survives process loss.
- Retries are bounded.
- Duplicate inbound events should resolve to the same work.
- Junior does not intentionally repeat an accepted reply.
- An ambiguous Slack delivery failure may still produce a duplicate reply on retry.

## Next Step

Read [Conversations](/concepts/conversations/) for thread behavior or [Security & Authority](/concepts/security-and-authority/) for action controls.
