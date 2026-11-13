# Slack Code Channel Threads

## Summary

When Junior starts a Thread from a public Slack channel, Junior opens a Slack
code channel for it. The code channel is the Location of the Thread. People
talk to the Thread there. The origin Slack thread gets only the code channel
card that Slack posts, and a message from Junior when the origin must know or
act.

A Thread with a code channel is a **channel Thread**. It acts like a root
Conversation at its own Location, and it keeps its parent. A Task does not
get a code channel. A Thread without a code channel works as it does today.

The feature is behind the `code-channels` experimental feature.

`design.md` has the model and the rules. `specs/` has the requirements.
`tasks.md` has the steps and the release order.

## Motivation

- Long work in a Slack thread fills the thread with Junior's transcript.
  People who only want the outcome must read every step.
- A Thread is the work item that people own and talk to. Today it has no
  Slack surface. People must open its dashboard link to talk to it.
- Slack code channels give agent work its own channel. Slack links the
  channel to the message that started it with a card in the origin Slack thread,
  and shows a session status in the sidebar. Code channels do not need a
  repository. A diff tab and a context bar are optional.
- Junior already decides when work is a Thread. That decision is the same
  decision as "this work needs its own place". So code channels need no new
  routing step.

## From David Cramer

- Open code channels for Threads, not for Tasks and not for every mention.
- A channel Thread notifies its parent only when the parent obviously must
  know. The conversation happens in the code channel.
- Ship behind an experiment.
- Do a rigorous check of the user experience before the build, with evals for
  the behavior.

## Plan Decisions

These came from the design discussion. David agreed with them.

- Only a Thread whose parent is a root Conversation at a public Slack
  channel gets a code channel. Not DMs, not group DMs, not private channels,
  not Slack Connect channels, and not Threads that start from the dashboard,
  the CLI, or an Automation run without a Slack channel.
- Only Threads one level below the root get a code channel. A Thread that a
  channel Thread starts is a plain Thread.
- A mention inside a code channel never opens another code channel.
- When the code channel cannot be created, the Thread works as a plain
  Thread. The dashboard link stays. People see no error.
- The dashboard link stays on every Thread. The code channel is the main link
  for a channel Thread.
- The parent is silent by default. The channel Thread sends the parent a
  message only in the cases in `design.md` (Notify The Parent). The runtime
  always sends one wrap-up message to the parent when the code channel is
  archived.
- In the code channel, Junior answers messages that are for Junior, also
  without a mention. It stays quiet when people talk to each other.
- No automatic archive in the first version. People archive the code channel,
  or Junior offers an archive action after a wrap-up summary.

## Scope

- The `code-channels` experimental feature.
- Slack app manifest: the `code_channels` feature and the
  `code_channels:manage` scope.
- Code channel creation when a Thread starts, with fallback.
- A channel Thread Turn behavior.
- Slack ingress: messages in a code channel go to its channel Thread.
- Delivery of channel Thread output to the code channel.
- Session status, the stop button, and archive in the code channel.
- The parent contract: when a channel Thread messages its parent, and the
  wrap-up message.
- Root steering: when to start a Thread instead of doing the work inline.
- Evals and integration tests.

## Non-Goals

- Code channels for Tasks or for root Conversations.
- Code channels from private channels or DMs. This needs an audience rule
  first (`design.md`, Privacy).
- Automatic archive of idle code channels.
- Context bar items, a plan tab, a diff tab, or other view tabs. These are
  follow-ups (`tasks.md`, Later).
- A reminder in the origin Slack thread when a question in the code channel gets no
  answer. This is a follow-up.
- Sync of origin Slack thread messages into the code channel.

## Dependencies

- Slack must let Junior create code channels. Slack documents that only
  approved agent apps can create them now (`feature_disabled`). Step 0 checks
  this. If Slack does not allow it, the plan stops at step 0.

## Sources

- Slack Code developer guide: https://docs.slack.dev/ai/slack-code/
- Code channel lifecycle: https://docs.slack.dev/ai/slack-code/lifecycle
- `agents.conversations.create`:
  https://docs.slack.dev/reference/methods/agents.conversations.create
- Agent sessions: https://docs.slack.dev/ai/agent-sessions
- Slack help center: https://slack.com/help/articles/54310833022355
