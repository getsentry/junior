---
title: Execution Model
description: How Junior turns a request into durable work and a reply.
type: conceptual
summary: Understand how Junior accepts work, runs a turn, and survives pauses or retries.
prerequisites:
  - /start-here/using-junior/
related:
  - /concepts/conversations/
  - /concepts/security-and-authority/
  - /concepts/tasks/
---

Junior does not do important work only in the original webhook request. It accepts work, stores it, and runs it through a durable conversation path.

## Lifecycle

1. A message, task, or plugin event arrives.
2. Junior validates it and stores the work on the conversation.
3. A worker claims that conversation and starts or resumes a turn.
4. The turn uses tools, skills, and sandbox commands as needed.
5. Connected-account traffic is authorized only when a real provider request needs it.
6. Completed replies go back to the original destination.
7. If the turn pauses for auth, timeout, or continuation, Junior resumes from the last safe checkpoint.

The queue is a wake-up signal. The stored conversation work is the source of truth.

## Turns, not one-shot requests

A **turn** is one request through to a finished response. It may span more than one worker attempt.

That matters when:

- OAuth is required mid-turn
- a long tool loop needs another slice of compute
- a worker dies and recovery picks the work back up

Junior keeps the same conversation and turn identity across those resumes. Work already committed in agent history should not be invented again from scratch.

## Ordering and interruption

Each conversation runs one worker at a time.

- New mentions can join at the next safe boundary.
- Other inbound messages wait until the active turn finishes.
- Progress updates are status, not the final answer.
- Text attached to tool calls stays internal until there is a real reply.

If Junior intentionally has nothing to say, that is a no-reply outcome. Missing text alone is not treated as success.

## Delivery guarantees

Expect these defaults:

- accepted work survives process loss
- retries are normal and bounded
- duplicate provider deliveries should converge on the same work
- an accepted reply is not intentionally sent twice
- if delivery fails in an ambiguous way, a later retry may produce a duplicate reply

Sandbox state can disappear. Durable product state lives in Junior's stores, not on the sandbox filesystem.

## What this is not

- It is not “the model keeps a live session open forever.”
- It is not exactly-once delivery for every chat provider edge case.
- It is not ambient access to every tool and credential in your company.

## Next step

Read [Conversations](/concepts/conversations/) for thread and visibility rules, or [Security & Authority](/concepts/security-and-authority/) for what is allowed during a turn.
