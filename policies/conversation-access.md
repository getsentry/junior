# Conversation Access

## Intent

One rule decides who may read, find, or act on the data of a Conversation.
It applies to every surface: agent tools, Code Mode scripts, the dashboard,
the API, MCP, memory, Briefs, search, and plugins. A new feature uses this
rule. It does not add its own rule.

## Policy

- The root Conversation decides access. Child Conversations, events,
  Messages, Briefs, Annotations, artifacts, and plugin records use the
  visibility and Owner of their root.
- **Public**: any person or agent in the same provider tenant (for example,
  one Slack workspace) may read and find it.
- **Private**: only its Owner may read and find it. Channel membership, an
  earlier message, or a mention does not give access.
- A request from a public Conversation never gets data from a private
  Conversation, also when the person owns it. Anyone who can see the public
  Conversation can see its output.
- A Turn with no person (an Automation run, a plugin dispatch, or another
  system Actor) has no Owner. It gets only public Conversations.
- A Turn may always use its own Conversation and the child agents below it.
- Missing or unknown visibility is private. A missing Owner gives no access.
- Find and act follow read. A search returns only Conversations that the
  requester may read. A tool that acts on another Conversation, such as
  `messageAgent`, checks the same rule. Give the same error for "not found"
  and "no access", so that the error does not show that a private
  Conversation exists.
- Apply the rule before content enters model context, a tool result, or a
  log. Code: `canAccessConversation` in
  `packages/junior/src/api/conversations/access.ts`.
- Read access does not give permission to act with the connected account of
  another person.

## Exceptions

- Dashboard transcript views also let recorded participants of a private
  Conversation read it (`canViewPrivateContent`). This is older than this
  policy. Agent-facing code must not use it.
- `searchConversationEvents` and `searchConversationBriefs` allow only public
  Conversations outside the current tree. They are stricter than this policy.
