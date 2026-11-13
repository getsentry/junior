# Tasks

## How To Use This Plan

- This plan fixes the target and the rules. It does not fix the
  implementation.
- At the start of each step, check this plan against current `main`.
- Settle the details of a step in its PR. The "Decide in this step" bullets
  list the open details.
- When a target or a rule must change, update this plan in the same PR. A
  change to a decision in `proposal.md` (From David Cramer, Plan Decisions)
  needs David's OK.
- Follow `policies/testing.md`. Runtime behavior gets integration tests
  through real Junior wiring with a fake Slack. Agent judgment gets evals.

## Release Rules

- Each step ships alone and leaves `main` correct.
- Every step before step 7 ships with `code-channels` off. With the flag off,
  no behavior changes.
- Readers ship before writers. Ingress for code channels (step 2) ships
  before any code creates one in production.
- Each step is safe under a rolling deploy. Code channels exist only after
  step 7 turns on the flag. By then, every worker has the step 2 ingress, so
  no worker sends a code channel message to a root.

## 0. Check Slack Access

- In a Slack developer sandbox, enable `features.code_channels` on a test
  app and call `agents.conversations.create` from a public channel message.
- Record the result. On `feature_disabled`, ask Slack to allow the Junior
  app. Stop the plan until Slack allows it.
- Check what the card in the origin Slack thread shows: title, status, summary.
  Update `design.md` with the result.
- Check how the card post appears to Junior's ingress in the origin Slack thread.

## 1. Flag, Manifest, And Slack Client

- Add `code-channels` to `EXPERIMENTAL_FEATURES`.
- Add `features.code_channels.enabled` and the `code_channels:manage` bot
  scope to `slack-manifest.yml`. Update the Slack app setup docs. Draft
  #1915 already adds the feature flag to the manifest. Finish it or close it
  in this step.
- Add Slack-owned calls for `agents.conversations.create`,
  `agents.conversations.archive`, and `agents.sessions.setStatus` without
  `thread_ts`.
- Add the terms **Code channel** and **Channel Thread** to `TERMINOLOGY.md`.
  Change Delivery: a root or a channel Thread delivers to its Location.

Decide in this step: the error mapping from Slack errors to the fallback.

## 2. Code Channel Ingress

- Bind a code channel to its Conversation with a provider Conversation
  binding.
- Send every message event in a bound code channel to its channel Thread,
  top-level or in a Slack thread.
- Skip Junior's own messages and Slack system messages. Map the
  `channel_archive` and `channel_unarchive` subtypes to archive and restore.
- Send a mention in a code channel to the channel Thread.
- Tests: a fake code channel message reaches the bound Thread; a message in an
  unbound channel works as today.

Decide in this step: how the reply decision gets the code channel input.

## 3. Channel Thread Turn Behavior And Delivery

- Add the channel Thread behavior to `kind-behavior.ts` (`design.md`, Turn
  Behavior).
- Deliver final responses to the code channel as top-level messages.
- Allow Tasks from every channel Thread Turn. Run a Task result Turn as the
  Actor that started the Task.
- Remove `reply` from channel Thread Turns. Keep `messageAgent` to the
  parent.
- Tests: person Turn, Agent invocation Turn, Task result Turn, and Watch
  Event Turn each post to the code channel or stay quiet with `noReply`.

## 4. Create The Code Channel From spawnAgent

- When a Thread is eligible (`specs/`), create the code channel before the
  first Agent invocation. Use the Thread's Conversation id as `session_id`,
  so a retry returns the same channel.
- Store the Location and the binding. Return the code channel from
  `spawnAgent`.
- On failure, start a plain Thread (`design.md`, Fallback).
- Do not post in the origin Slack thread. Make sure the card post starts no Turn.
- Tests: eligible Thread, Task, DM root, private root, nested Thread,
  `feature_disabled` fallback, retry with the same `session_id`.

## 5. Status, Stop, And Archive

- Set the session status from Turn state (`design.md`, Status And Stop).
  Send `processing` again during Turns longer than one hour.
- Stop the channel Thread on `agent_session_stopped` with no `thread_ts`.
- Add the archive action to Junior's summary message. On archive, call
  `agents.conversations.archive`, archive the Thread, and send the wrap-up
  message to the parent.
- Restore the Thread on `channel_unarchive`.
- Tests: status changes, stop, archive from the action, archive in Slack,
  restore.

Decide in this step: how Junior marks a message as the summary message.

## 6. Steering And Evals

- Root Steering in the `spawnAgent` `kind` description. Remove the "share
  the dashboard link" line for channel Threads.
- Notify The Parent steering in the channel Thread system prompt.
- Add `behavioral` evals:
  - **Routing:** a lookup is answered in place; "fix this bug and open a
    PR" starts a Thread; a request that is not clear is answered in place.
  - **Code channel replies:** people talk to each other, and Junior stays
    quiet; a question for Junior without a mention gets an answer.
  - **Notify the parent:** progress sends nothing to the parent; a block on
    an origin Slack thread person messages the parent; a parent question gets an
    answer through `messageAgent`.
  - **Origin follow-ups:** a status question gets an answer from the channel
    Thread state with no new Thread; new input for the same goal goes to the
    open channel Thread; a new goal goes through Root Steering.
  - **Wrap-up:** the summary makes sense alone; the parent posts in the
    origin Slack thread only when the origin asked for an outcome.
- Fix the product, fixture, or case shape before more prompt text
  (`policies/agent-steering.md`).

## 7. Turn On The Experiment

- Turn on `code-channels` for Sentry's Junior deployment in
  `getsentry/junior-prod`.
- Add the telemetry in `design.md`, Experiment Signals, in the steps that own
  each signal. Review the signals after two weeks.
- Decide to keep, change, or remove the experiment from the signals.

## Later

These are out of scope for this plan. Each needs its own change.

- A reminder in the origin Slack thread when a question in the code channel has no
  answer for a set time.
- Context bar items from the Conversation's Annotations (PR, ticket, Sentry
  issue, repository).
- A plan tab from `updatePlan`, and other view tabs.
- Code channels from private channels, after an audience rule.
- Automatic archive of idle channel Threads.
- When the experiment ends, move the lasting rules into code, policies, and
  docs, and delete this plan.
