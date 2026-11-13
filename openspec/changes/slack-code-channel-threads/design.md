# Design

This file gives the model, the rules, and the known risks. It does not fix
the implementation. Each step in `tasks.md` settles its own details. A detail
marked "current proposal" is not decided.

## Model

- A **channel Thread** is a Conversation of kind `thread` whose Location is a
  Slack code channel. The kind does not change. The Location makes it a
  channel Thread.
- The Location is the code channel with no `threadTs`. Junior sets it one
  time, when Slack creates the channel.
- A Thread with no Location is a plain Thread. It works as it does today.
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
behavior applies to every Turn in a channel Thread: a person's Turn, an
Agent invocation Turn from the parent, a Task result, and a Watch Event.

- **Delivery:** `location`. The final response goes to the code channel.
- **Not gated.** `noReply` ends a Turn with no message in the code channel,
  as on a root.
- **Parent:** `messageAgent` with `to: "parent"` is the only way to reach the
  parent. There is no `reply` tool. An Agent invocation from the parent ends
  with no result. The parent gets an answer only through `messageAgent`.
- **Agents:** a channel Thread can start Tasks. Today a person's Turn in a
  Thread cannot, because child results would report to the parent as the
  wrong Actor. In a channel Thread, a child result returns to the channel
  Thread and goes to the code channel. A Task result Turn runs as the Actor
  that started the Task (`openspec/changes/actor-identity-end-state`).
- **Threads:** a channel Thread cannot start a Thread with a code channel.
  It can start a plain Thread only if the depth limit allows it.
- **Review desk and Watches:** available. People in the code channel are
  the assignees.
- **Session tasks:** off. Memory is public, so a child never captures it.

Why one behavior for all Turns: the default audience of every Turn is the
people in the code channel. The parent is the exception. Today a Thread has
the opposite default. Its agent Turns answer the parent.

Current proposal: model this as a third pair in `kind-behavior.ts`, selected
by `kind === "thread"` and a code channel Location.

## Lifecycle

1. A person mentions Junior in a public channel. The root Turn runs as
   today. It answers in place, or it starts a Thread for work that needs one
   (Root Steering).
2. `spawnAgent` with `kind: "thread"` creates the Thread. When the Thread can
   get a code channel, Slack-owned code calls `agents.conversations.create`
   with the origin channel and the origin message, and a `session_id` set to
   the Thread's Conversation id. Then Junior stores the Location and the
   binding, and starts the first Agent invocation.
3. Slack creates the channel, adds the person who wrote the origin message,
   sets the channel public, and posts a card in the origin Slack thread. The card
   is the reply that people see. The root ends its Turn with `noReply`.
   `spawnAgent` returns the code channel, so the root knows that the card
   exists.
4. The first Turn of the channel Thread gets the brief and the origin Slack thread
   as context. It starts the work in the code channel.
5. People and Junior work in the code channel. Junior posts top-level
   messages. It answers messages for Junior without a mention.
6. When the work is done, Junior posts a summary with an archive action. A
   person archives the code channel with the action or in Slack.
7. On archive, Junior calls `agents.conversations.archive` with the summary
   message when one exists, archives the Thread, and sends the wrap-up
   message to the parent.
8. People cannot post in an archived channel. A person who reopens the code
   channel in Slack restores the Thread (`channel_unarchive`). When a person
   archives the code channel in Slack, Junior cannot record a summary
   message. The wrap-up message then uses the latest Brief.

### Fallback

When code channel creation fails, Junior keeps the Thread as a plain Thread
and starts it as today. `spawnAgent` returns the dashboard link and no code
channel. The root shares the link as today. Expected failures include
`feature_disabled`, `user_not_enabled`, `restricted_action`,
`origin_channel_externally_shared`, and `origin_channel_is_file_channel`.
Junior records the failure in telemetry. Unexpected failures follow
`policies/error-handling.md`.

## Root Steering

- A root starts a Thread for work that takes many steps, needs back-and-forth
  with the requester, or makes long output. A root answers in place when one
  message is enough, or when the request is about the current Slack thread.
- When the case is not clear, answer in place.
- This rule has one home: the `kind` field of `spawnAgent`
  (`policies/agent-steering.md`). The `spawnAgent` description stops telling
  the model to share the dashboard link when the result has a code channel.
- One open channel Thread per origin Slack thread is the default. New input
  for the same goal goes to the open channel Thread.

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

Current proposal: the steering for this list lives in the system prompt of
channel Thread Turns, because it is a delivery rule for one Conversation
type. It does not go into the `messageAgent` description.

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

- A message event in a bound code channel goes to the channel Thread. The
  sender is the Actor. A mention is not required.
- A message from a person that is not for Junior ends with `noReply`. Reuse
  the subscribed reply decision (`subscribed-reply-policy`), with a code
  channel input that leans toward an answer. Current proposal: pass the
  channel kind to the decision, not a second classifier.
- A mention in a code channel goes to the channel Thread. It never goes to a
  root and never opens a code channel.
- Junior's own messages and the Slack system messages of the channel do not
  start Turns. `channel_archive` and `channel_unarchive` message subtypes
  archive and restore the channel Thread.

## Status And Stop

- Junior sets the session status with `agents.sessions.setStatus` and the
  code channel id, with no `thread_ts`. This replaces
  `assistant.threads.setStatus` for a channel Thread.
- A running Turn sets `processing`. A Turn that ends with an open review item
  or a question for a person sets `suspended`. Other Turns set `active`.
  Slack ends `processing` after one hour, so a long Turn sends it again.
- `agent_session_stopped` without `thread_ts` from a code channel stops the
  channel Thread and its child agents, as the stop keyword does.

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
| Sidebar fills with code channels                 | One per Thread. Archive action. Slack hides idle ones.   |
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
