# Conversation Access

## Intent

Private Conversations are isolated. No data goes into or out of a private
Conversation, except through the people who look at it. One rule decides
when a Conversation may read, find, or act on the data of another
Conversation. A new feature uses this rule. It does not add its own rule.

## Terms

- **Requester**: the Conversation where the work runs and the output goes.
- **Target**: the Conversation whose data is read, found, or acted on.
- The root Conversation decides visibility. Child Conversations,
  events, Messages, Briefs, Annotations, artifacts, and plugin records use
  the values of their root. Missing or unknown visibility is private. A
  direct message is private. When the root or its Destination is missing,
  every row after row 1 denies.

## Rule between Conversations

Check the rows in this order. The first match decides.

| #   | Target                                         | Result |
| --- | ---------------------------------------------- | ------ |
| 1   | In the same Conversation tree as the requester | Allow  |
| 2   | Public                                         | Allow  |
| 3   | Private, outside the requester's tree          | Deny   |

- Public is public. Any Conversation may read a public Conversation. The
  surface (Slack, web, local) and the provider tenant (Slack workspace) do
  not change the result.
- Row 3 applies to every person and to every requester visibility. A
  person who is a participant of the target does not change the result.
- Code: `canAccessConversation` in
  `packages/junior/src/api/conversations/access.ts`. Its unit test has one
  case for each row.

## Writes

- A write needs read access first.
- A private requester never writes into a public Conversation. For
  example, `messageAgent` from a private Conversation to a public one is
  denied. Together with row 3, only public Conversations write into other
  Conversations.

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
- `searchConversationBriefs` and `searchConversationMessages` are only
  available in public Conversations and return only public Conversations.
  `searchConversationMessages` is a Slack tool, so it returns only Slack
  Conversations.
- Memories are public only (#2684).
