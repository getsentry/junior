# Review items

A Review item is work that needs a person. Agents add Review items. People
act on them on the review desk. See issue #2401 for the full product
behavior.

## Model

- A Review item has a kind, a status, a title, a body, and assignees.
- A `notice` only tells a person something. An `action` asks for an answer.
  Its `request` uses the same shape as `requestUserInput`: a question and 1-4
  fields.
- The status is `open`, `done`, or `dismissed`. Only a person or an agent
  closes an item. Nothing closes it on its own.
- An assignee is a User or **Everyone**. Everyone is a flag on the item. It
  means that any person who can see the item can act on it. The add tool
  needs at least one assignee.
- An item can have a subject, such as a pull request, and links to one or
  more Conversations. The Conversation of the agent that adds the item is
  always linked.
- An item from an Automation run stores the Automation id. A later run of the
  same Automation can see and change it.

## Dedupe key

- Each item has a dedupe key. Only one open item can use a key.
- When an agent adds an item with the key of an open item, it updates that
  item. The update replaces the content and the assignees. It keeps every
  linked Conversation and adds the new one.
- After an item closes, the same key can start a new item.
- The key follows the same rules as an update. An agent that cannot change
  the open item must use a different key.

## Visibility

- An item is `private` when a Conversation that added or updated it is not
  public. It is `public` otherwise. No change makes a private item public.
- A private item links only to the Conversation that added it, and to later
  runs of the same Automation. It cannot be assigned to Everyone. Each
  assigned User must be the Actor or a person in that Conversation.
- Each item stores the provider tenant, such as the Slack workspace, of the
  Conversation that added it. Every link must be in that tenant. A public
  item is visible only to readers in the same tenant.
- A reader can see an item when it is public in the reader's tenant, when the
  reader is an assigned User, when it is linked to the reader's Conversation,
  or when the reader's Automation added it. `canReadReviewItem` and the
  search query in `store.ts` apply the same rule.
- A public item can link other Conversations only when they are public.
- An agent can change a private item, or any item from a private
  Conversation, only from the Conversation or Automation that added it. This
  keeps private content out of other Conversations.
- An agent can never submit the answer to an action item. Only an assignee
  can submit.

## Tools

`addReviewItem`, `updateReviewItem`, and `searchReviewItems` are deferred
tools in the `review-desk` source (`chat/tools/review-items.ts`). A child
agent cannot use them. It reports to its parent with `reportBlocked`, and
the parent adds the item.
