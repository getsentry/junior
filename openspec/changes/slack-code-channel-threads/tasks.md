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

## Status

The draft PR that supersedes getsentry/junior#1915 builds steps 1 to 6 in
one branch, with these parts left:

- Step 0 is open. The card shape and its ingress event are not verified.
- Step 5: `processing` is not sent again during Turns longer than one hour.
- Step 6: the behavioral evals are not written. Integration tests in
  `packages/junior/tests` do not run the agent, so the delivery of final
  text and the "no result from final text" rule need an integration eval
  too.
- Experiment signals (step 7) are not added.

## Release Rules

- Each step ships alone and leaves `main` correct.
- Every step before step 7 ships with `code-channels` off. With the flag off,
  no behavior changes. The flag gates only creation. Routing, delivery,
  status, stop, and archive follow the binding.
- The Slack app config gets `features.code_channels` only after the step 2
  ingress is deployed. With the feature on, people can open code channels
  from Slack's own UI.
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
- Add Slack-owned calls for `agents.conversations.create` and
  `agents.sessions.setStatus` without `thread_ts`. v1 does not call
  `agents.conversations.archive` (no archive action).
- Add the terms **Code channel** and **Channel Thread** to `TERMINOLOGY.md`.
  Change Delivery: a root or a channel Thread delivers to its Location.

Decided: `design.md`, Fallback.

## 2. Code Channel Ingress

- Bind a code channel to its Conversation with a provider Conversation
  binding for the whole channel.
- Look up the whole-channel binding first on messages, mentions, the stop
  keyword, and `agent_session_stopped`.
- Send every message event in a bound code channel to its channel Thread,
  top-level or in a Slack thread, also with `passive-routing` off. Ignore
  `shouldUnsubscribe`. Run the allowed-domain check on non-mention Turns.
- Skip Junior's own messages and Slack system messages. Map the
  `channel_archive` subtype to archive.
- Send a mention in a bound code channel to the channel Thread. Detect an
  unbound code channel with `conversations.info`; a mention there runs a
  root Turn that opens no code channel.
- Tests: a fake code channel message reaches the bound Thread; a mention in
  an unbound code channel runs a plain root Turn; the card post (any bot
  post) in the origin Slack thread starts no Turn.

Decided for v1: no reply classifier in code channels. The model ends a Turn
with `noReply`. Open: reuse the subscribed reply decision.

## 3. Channel Thread Turn Behavior And Delivery

- Add the channel Thread behavior to `kind-behavior.ts` (`design.md`, Turn
  Behavior).
- Hold the Parent Contract (`design.md`): the parent mailbox gets only
  `messageAgent` texts and the wrap-up. Leave channel Threads out of
  `waiting_on`.
- Deliver final responses to the code channel as top-level messages.
- Allow Tasks from every channel Thread Turn. Run a Task result Turn as the
  Actor that started the Task.
- Remove `reply` from channel Thread Turns. Keep `messageAgent` to the
  parent.
- Tests: person Turn and parent message Turn post to the code channel; the
  parent gets only the `messageAgent` text, also after a failed Turn. Task
  result and Watch Event Turns need an integration eval.

## 4. Create The Code Channel From spawnAgent

- When a Thread is eligible (`specs/`), check the child limits and the live
  origin visibility, then create the code channel before the Thread. Use the
  Thread's Conversation id as `session_id`, so a retry returns the same
  channel. Give the Thread its task as a parent message, with no Agent
  invocation.
- Keep one open channel Thread per origin Slack thread: return the open one
  and send it the task.
- Store the Location and the binding. Return the code channel from
  `spawnAgent`.
- On failure, start a plain Thread (`design.md`, Fallback).
- Do not post in the origin Slack thread.
- Tests: eligible Thread, Task, origin that turned private, nested Thread,
  `feature_disabled` fallback, one open channel Thread per origin.

## 5. Status, Stop, And Archive

- Set the session status from Turn state (`design.md`, Status And Stop).
  Send `processing` again during Turns longer than one hour.
- Stop the channel Thread on `agent_session_stopped` from its code channel,
  with or without `thread_ts`. Post no ack and make no `agents.sessions.*`
  call. A stop in the origin Slack thread does not cascade.
- On `channel_archive`, archive the Thread and send the wrap-up message to
  the parent. Cut for v1: the archive action, summary-message marking, and
  `channel_unarchive` restore.
- Tests: status changes, stop, origin stop, archive in Slack, one wrap-up
  for a redelivered archive event.

## 6. Steering And Evals

- Root Steering in the `spawnAgent` `kind` description, only with the flag
  on. Remove the "share the dashboard link" line for channel Threads.
- Notify The Parent steering in the `messageAgent` description, only in
  channel Thread Turns.
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
