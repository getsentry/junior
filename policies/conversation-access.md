# Conversation Access

## Intent

Visibility and Destination are the only boundaries between Conversations.

- Public is public. Any Conversation may read and find a public
  Conversation. The surface (Slack, web, local) and the provider tenant
  (Slack workspace) do not change this.
- Private is isolated. No data goes into or out of a private Conversation,
  except through the people who look at it, or to another Conversation with
  the same audience. Every Conversation at one Destination, such as one
  private Slack channel or DM, has the same audience. Every Conversation in
  one private Space has the same audience too: the Space's members.

One rule decides when a Conversation may read, find, or act on the data of
another Conversation. A new feature uses this rule. It does not add its own
rule, and it does not add a surface or tenant check to public access.

## Terms

- **Requester**: the Conversation where the work runs and the output goes.
- **Target**: the Conversation whose data is read, found, or acted on.
- **Visibility**: `public` or `private`, stored on every Conversation row.
  A root takes the first known visibility of its Destination or Space, and
  each child copies its root's. Only an explicit change, such as a move into
  a private Space, changes it for the whole tree (`setConversationVisibility`);
  a Slack channel that becomes private does not. Queries check it with
  `isPublicConversation`. Missing visibility and direct messages are
  private. A missing root fails rows 2, 4, and 5, and row 6 denies.

## Rule between Conversations

Check the rows in this order. The first match decides.

| #   | Target                                          | Result |
| --- | ----------------------------------------------- | ------ |
| 1   | In the same Conversation tree as the requester  | Allow  |
| 2   | Root in the requester's private Space           | Allow  |
| 3   | Root in another private Space                   | Deny   |
| 4   | Root at the same Destination as the requester's | Allow  |
| 5   | Public                                          | Allow  |
| 6   | Private, in another tree and Destination        | Deny   |

- Row 4 skips a requester in a private Space, so the Space's data stays
  with its members. It compares only the Destination ids of the two roots.
  It has no provider or surface check. It is safe because of one invariant:
  Conversations share a Destination only when they have the same audience.
  A surface that cannot keep this invariant gives each Conversation its own
  Destination, as web and local Conversations do now. Slack shares one
  Destination across the threads of a channel, DM, or group DM.
- Row 6 applies to every person and to every requester visibility. A
  person who is a participant of the target does not change the result.
- Code: `canAccessConversation` in
  `packages/junior/src/api/conversations/access.ts`. Its unit test has a
  case for each row.

## Writes

- A write needs read access first.
- A private requester never writes into a public Conversation, such as
  with `messageAgent`. With row 6, a private Conversation writes only into
  Conversations at its own Destination or in its own private Space.
- One exception: the Lead of a public Space may write into any public root
  in its Space, for the member who asked it. Outside its Space, it may write
  only into a public root where that member is a Participant, as the member
  could. The Lead of a private Space gets no exception, so it writes only
  inside its Space.
- `startConversation` makes a root in the Space from its Lead, with the
  Space's visibility. It runs as the person who asked, and the Lead's task
  is its first message. Action review judges its task, then the new root's
  own tool calls, the same way it judges a child agent's.

## Rules for every surface

- Find and act follow read. A search returns only targets that the
  requester may read.
- Filters, such as `conversation_ids`, `annotation`, or `query`, only make
  the result smaller. They never add a target that the rule denies.
- Give the same error for "not found" and "no access", so that the error
  does not show that a private Conversation exists.
- Apply the rule before content enters model context, a tool result, or a
  log.
- Read access does not give permission to act with the connected account of
  another person.

## Rule for people

A person who reads directly, through the dashboard, the API, MCP, or ACP,
is not a Conversation. Anyone may read a public Conversation. A private one
is for its Participants or, in Slack, for its channel's members now
(`canViewPrivateContent`). This rule never lets one Conversation read another.

In a private Space, membership decides instead. Every member may read each
of its Conversations and join one by posting. A person who is not a member
may not read or act on them, even as a participant, and gets "not found"
for the Space. A member adds people to it.

## Surfaces

- `messageAgent`, `searchConversationEvents`, `readConversationEvent`, and
  `watchEvents` on a `conversation` resource use
  `canAccessConversation`.
  A Conversation Watch checks again at each delivery and fails closed,
  before any text from the target reaches the watcher.
- A Lead's `searchConversations` finds Conversations whose root is public,
  is at the Destination of the requester's root, or is in the requester's
  private Space. It finds child agents
  only when asked. It never finds the requester's own tree. Its results
  include the summary and outcome status. `participating` keeps only roots
  where the person is a Participant.
- `listAgents` with a `query` finds roots that are public, at the
  Destination of the requester's root, or in its private Space, and the Conversations in the
  requester's own tree, except the requester. Its results include the
  summary and outcome status. The requester's team ranks first, then the
  roots where the person it works for is a Participant.
- `searchConversationMessages` is only available in public Conversations
  and returns only public Conversations. It is a Slack tool, so it returns
  only Slack Conversations.
- Memories are public only (#2684).
