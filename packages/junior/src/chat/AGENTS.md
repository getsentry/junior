# Chat Runtime

Turns Source events into durable agent Runs and delivers completed assistant
messages.

## Flow

1. `ingress/` parses, classifies, and normalizes Source events.
2. Sources and agent invocations append mailbox work and send a queue wake
   through `task-execution/`.
3. A worker takes the Conversation lease, drains input, and restores state.
4. `runtime/` orchestrates the Turn. `agent/` runs Pi. `providers/` adds
   Source-specific input and Delivery.
5. Each completed tool-free assistant message goes through one awaited
   delivery port. The provider delivers it, then commits the agent message and
   the visible reply in one transaction.
6. Accepted delivery or intentional no-reply commits the Turn outcome.

## Ownership

- `app/` is the composition root only. `slack/` is low-level Slack transport.
- `agent-dispatch/`, `agent-invocations/`, `events/`, `event-automations/`,
  `scheduled-automations/`: durable work that becomes Conversation work.
- `agent/` and `pi/`: model execution and Pi state conversion. `guardian/`:
  action review.
- `task-input.ts`: agent input for every task. `automation-result.ts`:
  Automation run result. `model-profile.ts`, `services/turn-router.ts`: model
  profiles and Turn routes.

## Boundaries

- The native runtime must not import a provider layer. Low-level provider
  adapters must not orchestrate Turns.
- Runtime and service modules use small injected ports, never provider
  implementations or the production singleton.
- Verify Slack authors before storage, routing, or reactions
  (`ingress/workspace-membership.ts`). Event delivery does not prove
  membership.

## Source, Location, and Delivery

- Source and Actor describe the current Turn. Location is the optional place
  of the Conversation. Delivery sends output there. Keep them separate: no
  shared type, routing object, or wrapper.
- The work owner supplies Delivery before each new or resumed Run. Source,
  Actor, and Location do not select it.
- A child Conversation gets no Delivery or Location from its parent. A
  dashboard continue in a Slack Conversation keeps the Location but gets no
  Slack Delivery.
- Attribution does not grant authority. Credentials need the current Actor or
  an explicit delegated credential subject.

## Delivery and History

- Deliver each completed tool-free assistant message before the Run advances.
  Settle delivery before the Turn is finalized.
- Tool-bearing assistant text and tool failures stay internal.
- A tool-free reply that a destination accepted finishes the Turn for that
  reply. Hard timeout completes the Turn. It never parks a shorter history.
- Cooperative yield keeps the exact history, occurs only at a user or
  tool-result tail, and never rolls back past delivered output.
- Retry continuations keep an exact transcript prefix. Count usage from
  discarded tails once.
- Commit durable state before you acknowledge queue work or yield.

## Context and Limits

- Model input stays below the bot context cap and the model window. Check
  before the first request, after each tool batch, and on handoff.
- A history replacement keeps the open `updatePlan` items and the latest
  committed instruction verbatim. The summary is escaped evidence in
  `<thread-context authority="evidence-only">`, never a new instruction.
- Runtime context and the current instruction are separate user messages.
  Only `<current-instruction>` authorizes work. Request context, such as
  plugin context and Conversation notes, is true only for its own Turn.
- The durable tool-call total limits one Turn across slices. Compaction and
  handoff do not reset it.
- The automated-turn limit is kept on the Conversation. Event automation
  dispatches do not use it.

## Tools and Review

- Tool registration depends on the Conversation, not the Turn. To block a tool
  for one Turn, set `disabledReason` with `disableTools`. Do not remove it or
  put Turn text in its description or schema; this keeps the provider cache.
- Repo-owned tools declare all four tool hints. External tools without hints
  enter action review.
- Action review sees the validated, hook-adjusted input. Hook-injected
  environment values stay execution-only. Unavailable review fails closed.
- Commit each Guardian decision to the event log before the action continues.
  Guardian never sees signed credential bindings.

## Automation Runs

- `buildDispatchRoutingContext` sets `dispatch.declaresResult` once. Prompt,
  tools, and Delivery read that field, not the Source.
- An Automation run has no Delivery. It ends with `finishAutomationRun`. A
  failed run posts nothing to its outcomes.

## Replies

- Progress uses the status surface, never an assistant reply. `no_reply`
  needs an intentional no-reply. Missing text is not silence.
