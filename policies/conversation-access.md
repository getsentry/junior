# Conversation Access

## Intent

One rule decides who may read, find, or act on the data of a Conversation.
It applies to every surface: agent tools, Code Mode scripts, the dashboard,
the API, MCP, memory, Briefs, search, and plugins. A new feature uses this
rule. It does not add its own rule.

Invariant: a public Conversation never reads, finds, or acts on a private
Conversation. No row, filter, or Owner match changes this.

## Terms

- **Target**: the Conversation whose data is read, found, or acted on.
- **Requester**: the Conversation where the output goes. A person who reads
  the dashboard, the API, or MCP directly is a private requester.
- **Person**: the person of the current Turn. A Turn with no person (an
  Automation run, a plugin dispatch, or another system Actor) has none.
- The root Conversation decides visibility and Owner. Child Conversations,
  events, Messages, Briefs, Annotations, artifacts, and plugin records use
  the values of their root. Missing or unknown visibility is private.

## Scenarios

Check the scenarios in this order. The first match decides.

| #   | Requester                               | Target  | Person        | Result |
| --- | --------------------------------------- | ------- | ------------- | ------ |
| 1   | Same Conversation tree as the target    | any     | any           | Allow  |
| 2   | Other provider tenant (Slack workspace) | any     | any           | Deny   |
| 3   | any                                     | Public  | any           | Allow  |
| 4   | Public                                  | Private | any           | Deny   |
| 5   | Private                                 | Private | None          | Deny   |
| 6   | Private                                 | Private | Not the Owner | Deny   |
| 7   | Private                                 | Private | The Owner     | Allow  |

- Row 1: a tree has one root, so the requester and the target have the
  same visibility. This row never lets a public requester reach a private
  target.
- Row 4: anyone who can see a public Conversation can see its output, so it
  never gets private data. This is true also when the person owns the
  target.
- Row 6: channel membership, an earlier message, or a mention does not make
  a person the Owner.
- Code: `canAccessConversation` in
  `packages/junior/src/api/conversations/access.ts`. Its unit test has one
  case for each row.

## Rules for every surface

- Find and act follow read. A search returns only targets that the
  requester may read. A tool that acts on another Conversation, such as
  `messageAgent`, checks the same rule.
- Write needs one more check. Data that a private requester writes into a
  public target becomes public, so a private requester never writes into a
  public target. It may still read and find it.
- Filters, such as `conversation_ids`, `annotation`, or `query`, only make
  the result smaller. They never add a target that the rule denies.
- Give the same error for "not found" and "no access", so that the error
  does not show that a private Conversation exists.
- Apply the rule before content enters model context, a tool result, or a
  log.
- Per-person state, such as archive and pin, changes what a person sees in
  a list. It does not change access.
- Read access does not give permission to act with the connected account of
  another person.

## Surfaces

- `searchAgents`, `messageAgent`, `searchConversationEvents`, and
  `readConversationEvent` use `canAccessConversation`.
- `searchConversationBriefs` and `searchConversationMessages` are only
  available in public Conversations and return only public Conversations.
  This is rows 1 to 4.

## Exceptions

- Dashboard transcript views also let recorded participants of a private
  Conversation read it (`canViewPrivateContent`). This differs from row 6.
  Agent-facing code must not use it.
