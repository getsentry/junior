# Review items

A Review item is work that needs a person. Agents and plugins add Review
items. Assignees act on them on the review desk. An action item is the only
way the agent asks a person for input.

This module owns the store, access rules, person actions, and change
delivery. It does not own Slack cards (`chat/slack/review-item-card-sync.ts`),
the tools (`chat/tools/review-items.ts`), or the review desk API
(`api/review-items/routes.ts`).

## Access

`access.ts` owns every access rule. Do not copy a rule into a caller.

- An item is `private` when a Conversation that added or updated it is not
  public. No change makes a private item public.
- A private item links only to the Conversation that added it and to later
  runs of the same Automation. It cannot be assigned to Everyone. Assignees
  must pass `requireReviewItemAssignees`.
- An item belongs to one provider tenant. Links, readers of a public item,
  and Slack mention lookup must stay in that tenant.
- `canReadReviewItem` and `reviewItemVisibleTo` must give the same readers.
  `review-item-access.test.ts` checks this.
- Agent tools read as the Conversation, not as the Actor
  (`readReviewItemAgentScope`). This stops an agent from copying private
  content into another Conversation of the same User.
- `canAgentChangeReviewItem` limits agent changes. An agent never submits the
  answer to an action item. Only an assignee submits.

## Dedupe Key

- Only one open item in a provider tenant can use a dedupe key. A repeat with
  the key of an open item updates it and keeps every linked Conversation.
- Without an agent key, the tool call id is the key, so a tool retry updates
  the same item.
- The `plugin:` prefix is reserved for plugin items. An agent cannot add or
  change an item with it.

## Close And Delivery

- The first submit, complete, or dismiss closes the item for every assignee.
  A retry of the same close succeeds and sends only missing messages.
- Every change goes through `deliverReviewItemChange` in `changes.ts`. It
  shows the new state first, then sends messages to the other linked
  Conversations.
- A failed message fails the call. Each message has an idempotency key, so a
  retry sends only missing messages. A failed card does not fail the change.
- An agent close is an Event and does not give user approval. A person action
  is a web Message with the authority of that person.
- A plugin close sends no messages, so it does not start a Turn. It only
  calls `show`.
- Review item code must not import Slack code (`no-review-items-to-slack` in
  `.dependency-cruiser.mjs`).

## Reply In The Thread

- `closeReviewItemsAnsweredByReply` saves the message before it closes items,
  so the reply always reaches the agent.
- A reply closes only an open action item that this Conversation added and
  that the person may act on. Items assigned to Everyone stay open.
- A reply closes at most one item. When the person can answer more than one
  open item, the reply cannot show which one it answers, so all stay open.

## Purge And Delete

- A purge of a Conversation that is not public deletes its private items, like
  its Briefs (`chat/conversations/sql/purge.ts`). Public items stay.
- An open private item from an Automation run stays, because a later run can
  change it.
- An Automation delete dismisses its items and keeps the rows. Purge and
  delete send no message and do not change Slack cards.

## Slack Cards

- Cards are optional UI. Syncs of one item run under `withLock`, so two syncs
  cannot post two cards in one thread.
- A card click needs the same workspace and allowed domain checks as a Slack
  mention, plus a linked Junior User. Only the click that closes the item adds
  input, so two fast clicks add one Turn.
