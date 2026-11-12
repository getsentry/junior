# Conversation Access

## Intent

Visibility and Destination are the only boundaries between Conversations.

- Public is public. Any Conversation may read and find a public
  Conversation. The surface (Slack, web, local) and the provider tenant
  (Slack workspace) do not change this.
- Private is isolated. No data goes into or out of a private Conversation,
  except through the people who look at it, or to another Conversation at
  the same Destination. Every Conversation at one Destination, such as one
  private Slack channel or DM, has the same audience.

One rule decides when a Conversation may read, find, or act on the data of
another Conversation. A new feature uses this rule. It does not add its own
rule, and it does not add a surface or tenant check to public access.

## Terms

- **Requester**: the Conversation where the work runs and the output goes.
- **Target**: the Conversation whose data is read, found, or acted on.
- The root Conversation decides visibility. Child Conversations,
  events, Messages, Briefs, Annotations, artifacts, and plugin records use
  the values of their root. Missing or unknown visibility is private. A
  direct message is private. When the root or its Destination is missing,
  rows 2 and 3 do not match, and row 4 denies.

## Rule between Conversations

Check the rows in this order. The first match decides.

| #   | Target                                          | Result |
| --- | ----------------------------------------------- | ------ |
| 1   | In the same Conversation tree as the requester  | Allow  |
| 2   | Root at the same Destination as the requester's | Allow  |
| 3   | Public                                          | Allow  |
| 4   | Private, in another tree and Destination        | Deny   |

- Row 2 compares only the Destination ids of the two roots. It has no
  provider or surface check. It is safe because of one invariant:
  Conversations share a Destination only when they have the same audience.
  A surface that cannot keep this invariant gives each Conversation its own
  Destination, as web and local Conversations do now. Slack shares one
  Destination across the threads of a channel, DM, or group DM.
- Row 4 applies to every person and to every requester visibility. A
  person who is a participant of the target does not change the result.
- Code: `canAccessConversation` in
  `packages/junior/src/api/conversations/access.ts`. Its unit test has one
  case for each row.

## Writes

- A write needs read access first.
- A private requester never writes into a public Conversation. For
  example, `messageAgent` from a private Conversation to a public one is
  denied. Together with row 4, a private Conversation writes only into
  Conversations at its own Destination.

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
is not a Conversation. A participant of a private Conversation may read
and act on it there (`canViewPrivateContent`, `isParticipant`). This rule
never lets one Conversation read another.

## Surfaces

- `messageAgent`, `searchConversationEvents`, and `readConversationEvent`
  use `canAccessConversation`.
- `searchConversations` finds public roots and roots at the Destination of
  the requester's root. It never finds the requester's own tree. Its
  results include the latest Brief.
- `searchConversationMessages` is only available in public Conversations
  and returns only public Conversations. It is a Slack tool, so it returns
  only Slack Conversations.
- Memories are public only (#2684).
