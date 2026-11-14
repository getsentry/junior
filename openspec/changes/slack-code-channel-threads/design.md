# Design

This file gives the model, the rules, and the known risks. It does not fix
the implementation. Each step in `tasks.md` settles its own details. A detail
marked "current proposal" is not decided.

## Model

- A **channel Thread** is a Conversation of kind `thread` whose Location is a
  Slack code channel. The kind does not change. A provider Conversation
  binding for the whole channel (`provider_conversation_id = "*"`) marks it,
  not a flag. So a channel keeps working when the flag turns off.
- The Location is the code channel with no `threadTs`. Junior sets it one
  time, when Slack creates the channel.
- A Thread with no whole-channel binding is a plain Thread. It works as it
  does today.
- A channel Thread has no Agent invocations. The parent's task and later
  parent messages arrive as parent messages on the Conversation loop. So no
  result of the channel Thread reaches the parent mailbox (Parent Contract).
- The code channel is bound to the channel Thread with a provider
  Conversation binding, as `continue-in-slack` binds a moved Conversation.
  Every message in the code channel, top-level or in a Slack thread, goes to
  this one Conversation. Slack does not allow separate agent sessions in the
  Slack threads of a code channel.
- Visibility comes from the root, as for every child
  (`policies/conversation-access.md`). The root is at a public channel, so
  the channel Thread is public.

## Turn Behavior

A channel Thread acts like a root at its own Location, with a parent. One
behavior applies to every Turn in a channel Thread: a person's Turn, a
parent message Turn, a Task result, and a Watch Event.

- **Delivery:** `location`. The final response goes to the code channel.
- **Not gated.** `noReply` ends a Turn with no message in the code channel,
  as on a root.
- **Parent:** `messageAgent` with `to: "parent"` is the only way to reach the
  parent. There is no `reply` tool. A parent message Turn ends with no
  result. The parent gets an answer only through `messageAgent`.
- **Agents:** a channel Thread can start Tasks. Today a person's Turn in a
  Thread cannot, because child results would report to the parent as the
  wrong Actor. In a channel Thread, a child result returns to the channel
  Thread and goes to the code channel. A Task result Turn runs as the Actor
  that started the Task (`openspec/changes/actor-identity-end-state`).
- **Threads:** a channel Thread cannot start a Thread with a code channel.
  It can start a plain Thread only if the depth limit allows it.
- **Review desk and Watches:** available. Participants are the assignees.
- **Session tasks:** off. Memory is public, so a child never captures it.

Why one behavior for all Turns: the default audience of every Turn is the
people in the code channel. The parent is the exception. Today a Thread has
the opposite default. Its agent Turns answer the parent.

Built: `CHANNEL_THREAD` in `kind-behavior.ts`, selected by the kind and
the whole-channel binding (`isChannelThread`).

### Parent Contract

The parent mailbox gets only two things from a channel Thread: the texts of
its `messageAgent(to: "parent")` calls, and the one runtime wrap-up on
archive. In particular:

- No `completed` result from the final text of a Turn.
- No `replaced` chain from the results of its Tasks.
- No `failed` notice. A failure stays in the code channel.
- `waiting_on` (`listUnreportedSiblingAgents`) leaves channel Threads out.
- The `spawnAgent` result for a channel Thread says that it reports only
  with `messageAgent` and the wrap-up. It has no `dashboard_url`, and the
  "replies when it has something to report" line does not apply.

## Lifecycle

1. A person mentions Junior in a public channel. The root Turn runs as
   today. It answers in place, or it starts a Thread for work that needs one
   (Root Steering).
2. `spawnAgent` with `kind: "thread"` creates the Thread. When the root
   already has an open channel Thread for this origin Slack thread,
   `spawnAgent` returns it and sends it the task as a parent message. One
   open channel Thread per origin Slack thread is a product invariant, not
   steering. Otherwise, when the Thread can get a code channel, Junior checks
   the child limits, checks with a live `conversations.info` that the origin
   channel is still public, and calls `agents.conversations.create` with the
   origin channel, the triggering message ts as `origin_message_ts`, and a
   `session_id` set to the Thread's Conversation id. Then Junior creates the
   Thread, stores the Location and the binding, and sends the task as a
   parent message.
3. Slack creates the channel, adds the person who wrote the origin message,
   sets the channel public, and posts a card in the origin Slack thread. The card
   is the reply that people see. The root ends its Turn with `noReply`.
   `spawnAgent` returns the code channel, so the root knows that the card
   exists.
4. The first Turn of the channel Thread gets the brief and the origin Slack thread
   as context. It starts the work in the code channel.
5. People and Junior work in the code channel. Junior posts top-level
   messages. It answers messages for Junior without a mention.
6. A person archives the code channel in Slack. The `channel_archive`
   message subtype archives the Thread and its child agents, and the runtime
   sends the wrap-up message to the parent.
7. The wrap-up is always sent, one time per archive event. Its text is the
   outcome of the latest Brief, and it says whether the Thread already
   messaged the parent, so the root does not post the outcome again.
8. v1 has no archive action, no summary message, and no
   `channel_unarchive` restore. A person's new message already restores an
   archived Thread.

### Fallback

When code channel creation fails, Junior keeps the Thread as a plain Thread
and starts it as today. `spawnAgent` returns the dashboard link and no code
channel. The root shares the link as today. Expected failures are
`feature_disabled`, `user_not_enabled`, `restricted_action`,
`origin_channel_externally_shared`, `origin_channel_is_file_channel`,
`invalid_origin_link`, `channel_not_viewable`, `missing_scope`, and
`ratelimited` (Slack applies special rate limits to this method). Junior
logs the failure. Unexpected failures follow `policies/error-handling.md`.

On `invite_failed` or `open_failed`, the channel already exists, and its card
is in the origin Slack thread. Junior calls create again with the same
`session_id` to get the channel and binds it. It does not fall back and
leave that channel without a Thread.

## Root Steering

- A root starts a Thread for work that takes many steps, needs back-and-forth
  with the requester, or makes long output. A root answers in place when one
  message is enough, or when the request is about the current Slack thread.
- When the case is not clear, answer in place.
- This rule has one home: the `kind` field of `spawnAgent`
  (`policies/agent-steering.md`). The `spawnAgent` description stops telling
  the model to share the dashboard link when the result has a code channel.
- One open channel Thread per origin Slack thread. `spawnAgent` enforces it
  (Lifecycle, step 2).
- The `kind` description changes only when the flag is on. With the flag
  off, it is the same as today.

## Notify The Parent

The channel Thread sends `messageAgent` to the parent only when a person or
an agent outside the code channel must know or act:

- The origin Slack thread asked for an outcome. Send it one time, when it exists.
- The work is blocked on a person or an approval that only the origin Slack thread
  can give.
- The parent coordinates the work. For example, it started more than one
  channel Thread, or it sent the channel Thread a question.
- The work changed in a way that changes the discussion in the origin
  thread. For example, the bug is part of an open incident.

The channel Thread does not message the parent for progress, for questions
to the requester (the requester is in the code channel), for partial
results, or to say that the work is done when the card already shows it.

The runtime sends one wrap-up message to the parent on archive. It does not
depend on the model. Its text is the summary message, or the outcome of the
latest Brief when there is no summary. The parent decides whether the origin
thread needs a message. Usually it does not, because the card shows the
result.

Built: this list is in the `messageAgent` description, only in channel
Thread Turns (the `channel_thread` variant from `TurnBehavior`). This
changes the earlier proposal: the rule is about when to call one tool, so
it lives on that tool (`policies/tool-design.md`), and only Turns where the
binding applies see it.

## Origin Slack Thread Follow-Ups

- "Is it done?" in the origin Slack thread: the parent answers from the status and
  the Brief of the channel Thread. It does not wake the channel Thread or
  start another one.
- New input for the same goal: the parent sends it to the channel Thread with
  `messageAgent`. The channel Thread posts it in the code channel and acts.
  An Agent message gives no user approval.
- A different goal: the root uses Root Steering again.
- The card post in the origin Slack thread must not start a Turn.

## Code Channel Ingress

- Bindings are keyed by `thread_ts` today. Ingress looks up the
  whole-channel binding first on all four paths: messages, mentions, the
  stop keyword, and `agent_session_stopped`. A stop in a Slack thread inside
  a code channel stops the channel Thread.
- A message event in a bound code channel goes to the channel Thread. The
  sender is the Actor. A mention is not required. The binding gates this,
  not `passive-routing`. The subscribed decision's `shouldUnsubscribe` does
  not apply. A non-mention Turn gets the allowed-domain check.
- A message from a person that is not for Junior ends with `noReply`. v1
  runs no classifier: every person message runs a Turn, and the model
  decides with `noReply`. Open: reuse the subscribed reply decision
  (`subscribed-reply-policy`) with a code channel input.
- A mention in a bound code channel goes to the channel Thread. It never
  goes to a root and never opens a code channel.
- People can open code channels from Slack's own UI once the manifest
  feature is on. Junior detects an unbound one with `conversations.info`
  (`properties.record_channel.record_type === "agent_channel"`). In v1, a
  mention there runs a normal root Turn and never opens a code channel.
- Junior's own messages and the Slack system messages of the channel do not
  start Turns. `channel_archive` and `channel_unarchive` message subtypes
  archive and restore the channel Thread.

## Status And Stop

- Junior sets the session status with `agents.sessions.setStatus` and the
  code channel id, with no `thread_ts`. This replaces
  `assistant.threads.setStatus` for a channel Thread.
- A running Turn sets `processing`. A Turn that ends with an open review item
  sets `suspended`. Other Turns set `active`. Slack ends `processing` after
  one hour, so a long Turn must send it again (not built yet).
- `agent_session_stopped` from a code channel, with or without `thread_ts`,
  stops the channel Thread and its child agents, as the stop keyword does.
- After a stop from a code channel, Junior posts no ack and makes no
  `agents.sessions.*` call, as Slack's lifecycle doc requires. Only a
  person's input in the code channel ends the stop. A parent's
  `messageAgent` does not.
- A stop in the origin Slack thread does not cascade into channel Threads.
- A parent message waits behind a paused person Turn. It does not supersede
  it: a channel Thread has no Agent invocation for it to supersede.

## Flag

`code-channels` gates only creation, and the code channel text in the
`spawnAgent` `kind` description. Routing, delivery, status, stop, and
archive follow the binding. So flag-off or a rollback does not strand open
channels.

## Privacy

- Only public origin channels in this plan. The code channel is public, and
  the channel Thread is public through its root. No private data moves.
- A private origin is out of scope. Slack lets any member of a private code
  channel add more people. Then the audience of the code channel can grow
  past the audience of the private root. This breaks the rule that one
  Destination has one audience. A later plan must solve this first.

## UX Risks

| Risk                                             | Mitigation in this plan                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| A code channel for a small request               | Root Steering. Not clear means answer in place.          |
| Requester must leave the origin Slack thread     | Same as above. Only multi-step work moves.               |
| Origin and code channel talk about one topic     | Card links them. Parent forwards input. No sync.         |
| Junior talks over people in the code channel     | Reply decision with `noReply`. Evals.                    |
| Requester never opens the code channel           | Sidebar status `suspended`. Reminder is a follow-up.     |
| Parent posts too much in the origin Slack thread | Notify list. Wrap-up goes to the parent, not the thread. |
| Parent never hears the outcome                   | Runtime wrap-up message on archive.                      |
| Sidebar fills with code channels                 | One per origin Slack thread. Slack hides idle ones.      |
| Slack does not allow code channel creation       | Fallback to a plain Thread.                              |

## Experiment Signals

The flag is app-wide, so there is no control group in one deployment.
Compare with the two weeks before the flag turns on, and with Threads that
fell back to plain Threads. These signals are diagnostic
(`policies/observability.md`). Names come from `TELEMETRY.md` in the step
that adds them.

- Junior messages in origin Slack threads per root. Expect a large drop.
- The requester posts in the code channel within 30 minutes of creation.
- Origin Slack thread messages that ask about status. A high count means the
  channel Thread notifies too little.
- `messageAgent` to the parent per channel Thread. A high count means it
  notifies too much. The target is about one.
- Channel Threads in `suspended` for more than 24 hours.
- Channel Threads with two or fewer Turns. A high count means the root
  starts Threads for small requests.
- Code channel creation failures by error.
