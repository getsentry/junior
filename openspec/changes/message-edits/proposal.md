# Message Edits as Steering (Shelved)

## Status

Shelved on 2026-11-08. The code on this branch works and its tests pass.
The cost is too high for the payoff, so `main` keeps the #1872 rule: an
edit does nothing. Use this file and the branch as the starting point if
the work comes back.

## Goal

A Slack or GitHub edit never starts a Turn. It changes the input in place,
steers into the active Turn, or is saved as context.

## Design on This Branch

| Edit arrives when                     | Result                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| original is pending and no lease      | replace the pending input in place                        |
| a Turn runs                           | `interrupt` correction, steered at the next safe boundary |
| idle, or the Turn ends before a drain | worker saves it as a skipped Message, no Turn             |

- No new Mailbox delivery. A correction is an `interrupt` with
  `input.metadata.edit = { inboundMessageId? }`.
- The worker decides, not ingress. Before the session-stop check, an attempt
  with only edits is saved as skipped Messages ("edited message") and acked.
  One path covers idle edits and the race where a Turn ends before a drain.
- Edits get no priority in `isAttemptInterrupt`, do not change a paused
  Conversation to pending, skip `admitAutomatedTurn`, and never run Event
  automations.
- Later Turns read skipped Messages as context
  (`services/conversation-memory.ts`).
- Slack: only a person's edit (no `bot_id`, `edited` set, text changed,
  workspace member), only for a Conversation that exists. A mention that an
  edit adds starts no Turn. Steered text uses a `<message-edit>` tag.
- GitHub: `edited` for `issue_comment`, `pull_request_review_comment`, and
  `pull_request_review`, only to Watches of the created or submitted
  counterpart. No new catalog event types. plugin-api gets `edit?: true`.

## Why Not Other Options

- `defer`: an idle `defer` starts a Turn, and a running Turn drains only
  `interrupt`. A deferred edit always becomes a Turn.
- Check the lease at ingress: a Turn can end after the append and before its
  drain. The leftover `interrupt` then starts a Turn.
- Drop idle edits: loses input with no signal to the person.
- A new delivery value: more surface and a strict-schema rollout. The marker
  does the same work.

## Size at `e1cccb572`

| Part                | Raw      | Without blank and comment lines |
| ------------------- | -------- | ------------------------------- |
| Core mailbox/worker | +195/−15 | +160/−15                        |
| Slack               | +212/−13 | +178/−8                         |
| GitHub plugin       | +69/−17  | +61/−17                         |
| plugin-api          | +6/−0    | +1/−0                           |
| Tests               | +361/−1  | +330/−1                         |

The budget was about 250 code lines. Possible cuts: in-place replace (about
85), the `<message-edit>` render (about 25), GitHub (about 60 plus 115 test
lines).

## Known Problems

- Rollout: the Slack metadata schema is strict. An old worker probably
  rejects a marked message and retries it. Ship schema acceptance one deploy
  before the emitters. (Inferred, not run against old code.)
- Tests: `packages/junior/tests` cannot run the agent, so tests stop at the
  mailbox and the worker. Steering and in-place text need evals. The eval
  fixture `agent.ts` is near 1,000 lines and needs a split first.
- GitHub edits do not steer. No drain takes Events, so an edit joins the
  next Turn or is saved. In-place replace needs an eventKey from the comment
  id, not the delivery id.
- An idle edit is lost when the Redis Conversation record has expired.
- `slack-webhook.ts` (960), `events.ts` (962), and `slack-work.ts` (920) are
  near the file-length limit.

## If This Comes Back

1. Slack only first. Land schema acceptance, then the emitters.
2. Add eval cases for a steered edit and an in-place edit.
3. GitHub only after Events can steer into a running Turn.
4. Get sign-off from the #1872 owner. This changes its rule.
