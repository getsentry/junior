# Conversation Access

## Intent

Visibility and Destination are the only boundaries between Conversations.

- Public is public. Any Conversation may read and find a public
  Conversation. The surface (Slack, web, local) and the provider tenant
  (Slack workspace) do not change this.
- Private is isolated. No data goes into or out of a private Conversation,
  except through the people who look at it, or to another Conversation with
  the same audience. Every Conversation at one Destination, such as one
  private Slack channel or DM, has the same audience. A Space is one tree,
  so all of its Conversations have the audience of its Lead.

One rule decides when a Conversation may read, find, or act on the data of
another Conversation. A new feature uses this rule. It does not add its own
rule, and it does not add a surface or tenant check to public access.

## Terms

- **Requester**: the Conversation where the work runs and the output goes.
- **Target**: the Conversation whose data is read, found, or acted on.
- **Visibility**: `public` or `private`, stored on every Conversation row.
  A root takes the first known visibility of its Destination or Space, and
  each child copies its root's. It does not change after the root is
  created, even when its Slack channel becomes private. Queries check it with
  `isPublicConversation`. Missing visibility and direct messages are
  private. A missing root fails rows 2 and 3, and row 4 denies.

## Rule between Conversations

Check the rows in this order. The first match decides.

| #   | Target                                          | Result |
| --- | ----------------------------------------------- | ------ |
| 1   | In the same Conversation tree as the requester  | Allow  |
| 2   | Root at the same Destination as the requester's | Allow  |
| 3   | Public                                          | Allow  |
| 4   | Private, in another tree and Destination        | Deny   |

- In a Space, the Lead is the root, so row 1 covers the whole Space. Each
  Lead has its own Destination, so row 2 adds nothing outside its tree.
- Row 2 compares only the Destination ids of the two roots.
  It has no provider or surface check. It is safe because of one invariant:
  Conversations share a Destination only when they have the same audience.
  A surface that cannot keep this invariant gives each Conversation its own
  Destination, as web and local Conversations do now. Slack shares one
  Destination across the threads of a channel, DM, or group DM.
- Row 4 applies to every person and to every requester visibility. A
  person who is a participant of the target does not change the result.
- Code: `canAccessConversation` in `src/api/conversations/access.ts`. Its
  unit test has a case for each row.

## Writes

- A write needs read access first.
- A private requester never writes into a public Conversation, such as
  with `messageAgent`. With row 4, a private Conversation writes only into
  Conversations in its own tree or at its own Destination.
- A Lead writes into the Conversations of its Space as their parent, with
  `messageAgent`, and into other roots by the rule above, as any root does.
- A Lead starts work in its Space with `startAgent`, as a child with the
  Space's visibility. Action review judges its task as a child's task, with the
  `lead-member` rule in `design/guardian.md`.

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

Anyone may read a public root Conversation and Join it, but only its
Participants act on any Conversation: post, Invite, archive, and the rest
(`isParticipant`). Only they may read a private one
(`canViewPrivateContent`). A Slack Message adds its author. A web Message
and a mention add nobody. Each person may only Leave on their own.

A Space's members are the Participants of its Lead, and every Conversation
in it inherits them, as in any tree. A person who is not a member of a
private Space gets "not found" for the Space.

## Surfaces

- `messageAgent`, `searchConversationEvents`, `readConversationEvent`, and
  `watchEvents` on a `conversation` resource use
  `canAccessConversation`.
  A Conversation Watch checks again at each delivery and fails closed,
  before any text from the target reaches the watcher.
- A Lead's `searchConversations` finds roots that are public or at the
  Destination of the requester's root. It finds
  child agents only when asked, and never the requester's own tree. Results
  include the summary and outcome status. `participating` keeps only roots
  where the person is a Participant.
- `listAgents` with a `query` finds the same roots, plus the requester's own
  tree except the requester, with the summary and outcome status. The
  requester's team ranks first, then roots where the person it works for is
  a Participant.
- `searchConversationMessages` is only available in public Conversations
  and returns only public Conversations. It is a Slack tool, so it returns
  only Slack Conversations.
- Memories are public only (#2684).
