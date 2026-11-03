# Shared Conversation Core

## Summary

Every agent is a conversation. Top-level agents (Slack, web, ACP, CLI),
child agents and plugin-started agents use one inbox, one worker, one worker
lock and one way to start, pause, resume and finish a turn. They differ only
in stored data: where input comes from, who the turn acts for, and where
results go.

This plan is the end state for #2567. It supersedes #883. `design.md` has the
model, the words and the answers. `interfaces/` has the type and
function sketches with worked examples for review. `specs/` has the
requirements. `tasks.md` has the migration steps.

## Why

- Each kind of work has its own code to find the current turn, join new
  input, handle the last try, stop and finish. The copies drifted apart, and
  many runtime fixes since February trace back to that (#2567, Why it keeps
  happening).
- One piece of work has up to four status records (conversation, turn, child
  agent request, plugin-started agent). Code copies status between them after
  the fact. When a copy is missed, they disagree.
- When Junior gives up after the last retry, or a worker dies, only the
  conversation status changes. The turn, the child agent request and the
  plugin-started agent can stay "running" or "paused".
- Saves to the turn and to history do not check that the worker still holds
  the worker lock. A late save can reopen a finished turn.
- Who a turn acts for is worked out in several places. Some of them guess
  from "the latest request". That is a confused deputy risk.

## What Changes

- One worker runs every kind of conversation. The four per-kind workers and
  their last-try branches go away.
- A turn record is the only turn status. A conversation has at most one open
  turn, and the store enforces it.
- Every save and every post carries the lock version. An old version is
  refused.
- One `finishTurn` ends every turn: done, error, stop, no progress, a limit,
  the last retry, a lost worker with no restart left, sign-in expiry or
  supersede. It is the only writer of turn and request record status.
- A request record holds who asked, with whose access, and where results go.
  Core mints one for every input. It has no run status. `spawnAgent` and
  `messageAgent` save one and put one message in the child's inbox. They never
  start a second runner.
- A child's turn result goes to the parent's inbox as new input, with its
  own record in the parent. The parent checks the sender from the child's
  turn row.
- A stop saves a stop time on the conversation. Stopping a top-level agent
  stops its whole tree.
- The sandbox pass ends with its turn, and the credential proxy checks it
  against the open turn.
- A TLA+ model checked by TLC, conformance tests, structural rules and a
  trace check gate the new core. The gate ships first and is green before
  the cutover release. It lives in `packages/junior/verification/`, not in
  this plan (`design.md`, Verification).

## Decided And Proposed

- Decided items come from David Cramer's answers on #2567 (decision comments
  1–4) and in the planning thread. `design.md` cites each one as
  **Decided**.
- Everything marked **Proposed, needs sign-off** is a suggestion from this
  plan. It is not decided. `design.md`, Decisions Needed, lists them all.
  `design.md`, Later, lists items this change does not need.
- A change to a decided rule needs David's OK.

## Specs

One spec per capability: `conversation-inbox`, `turn-lifecycle`,
`turn-stop`, `turn-access`, `agent-tree`, `plugin-started-agents` and
`verification`. They are built from the 3 behavior story comments on #2567.
A requirement with no label keeps today's behavior. **(Decided)** and
**(Proposed, needs sign-off: Pn)** point to `design.md`.

## Non-Goals

These carry over from #883:

- A separate child agent runtime, queue, worker lock, checkpoint format or
  recovery loop.
- Exactly-once queue delivery.
- Watches as the protocol for child results.
- Full-history forks by default.

Also out of scope:

- Child agent sign-in (#881). A child that needs sign-in ends `blocked`.
- New features for Automations, Watches or the dashboard.
- Code changes in this branch. This branch is the plan only.

## Related

- #2567 (target design, audit, behavior stories, decisions)
- #883 (superseded)
- #2556 (retried prompt save; lands on its own, outside this plan and the
  gate)
- `openspec/changes/actor-identity-end-state` (Owner and event authors)
