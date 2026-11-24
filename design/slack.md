# Slack

A user talks to Junior in Slack, in a DM or by a mention in a channel.
Junior answers in the thread of the request, and can read other public
channels for context.

## Intent

- Only people in the organization can start work. A message from someone
  outside the organization is never a request.
- Junior never exposes internal data to people outside the organization
  through Slack.
- Junior can be a member of a channel that is shared with another
  organization, so that its messages are context for work elsewhere. It
  takes no requests there.

## Rules

- In a channel shared with another organization, no message starts a Turn
  or runs an Automation, also when a person in the organization mentions
  Junior.
- Junior reads another channel only when it is public. A private channel is
  readable only from a Conversation in it.
- A post from another app runs only an Automation that names the app. It
  never starts a Turn.

## Gaps

- Work that starts somewhere else can still post in a shared channel, such
  as an Automation whose Destination is that channel. Guardian treats every
  Slack channel of the organization as inside it, so it does not stop
  private data there. This breaks "never exposes internal data to people
  outside the organization" ([Guardian](./guardian.md)).
