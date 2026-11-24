# Slack

A user talks to Junior in Slack, in a DM or by a mention in a channel.
Junior answers in the Slack thread of the request, and can read other
public channels for context.

## Intent

- Only people in the organization can start work. A message from someone
  outside the organization is never a request.
- Junior never exposes internal data to people outside the organization
  through Slack.
- Junior can be a member of a channel that is shared with another
  organization, so that its messages are context for work elsewhere. It
  takes no requests there.

## Entry points

- Slack: a DM, or `@jr` in a Slack thread of a channel. After Junior
  replies in a Slack thread, later replies there need no mention.
- Slack: a channel-message Automation ([Automations](./automations.md)).
- Slack: a link to a message or Slack thread in another channel, which
  Junior reads.

## Rules

- In a channel shared with another organization, no message starts a Turn
  or runs an Automation, also when a person in the organization mentions
  Junior.
- Junior reads another channel only when it is public. A private channel is
  readable only from a Conversation in it.
- A post from another app runs only an Automation that names the app. It
  never starts a Turn.

## Gaps

- Work that starts somewhere else can post in a shared channel, such
  as an Automation whose Destination is that channel. Guardian treats every
  Slack channel of the organization as inside it, so it does not stop
  private data there. This breaks "never exposes internal data to people
  outside the organization" ([Guardian](./guardian.md)).
- In a Slack thread where Junior already replied, a later reply with no
  mention starts no Turn in production. This breaks "later replies there
  need no mention".
- In a channel shared with another organization, a click on an Inbox card
  counts as the person's answer and starts a Turn, and the reply goes to
  that channel. This breaks "no message starts a Turn" there, and "never
  exposes internal data to people outside the organization".
