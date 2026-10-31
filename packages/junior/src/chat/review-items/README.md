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
  always linked. An update cannot remove that link.
- An item from an Automation run stores the Automation id. A later run of the
  same Automation can see and change it.

## Dedupe key

- Each item has a dedupe key. Only one open item in a provider tenant can
  use a key. Other tenants do not see the key and can use it too.
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
  assigned User must be the Actor, or a person in the current Conversation
  or in the Conversation that added the item.
- Each item stores the provider tenant, such as the Slack workspace, of the
  Conversation that added it. Every link must be in that tenant. A public
  item is visible only to readers in the same tenant. A Slack mention in
  the assignees resolves only to a User in that tenant.
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

## Person actions

`actions.ts` owns what a person can do. The review desk API
(`api/review-items/routes.ts`) calls it.

- An assigned User can act on an open item. Anyone who can see the item can
  act when it is assigned to Everyone or when it has no assignees.
- **Take** makes the person the only assignee. The item stays open.
- **Submit** saves the answer to an action item and marks it `done`.
- **Complete** marks a notice `done`. An action item needs an answer, so it
  cannot be completed.
- **Dismiss** marks any item `dismissed`.
- The first submit, complete, or dismiss closes the item for every assignee.
  The item records who closed it and when. A retry of the same close
  succeeds and sends missing messages again.

## Messages to linked Conversations

`messages.ts` tells linked Conversations about a change. Each message starts
a new Turn.

- A person action goes to every open linked Conversation. It is a web
  Message from that person, so it has the authority of that person, like a
  reply in Slack. A Conversation that does not take web Messages gets an
  Event instead.
- An agent close goes to every other open linked Conversation as an Event.
  It does not give user approval.
- A Conversation is open until Junior purges its transcript. Archive is
  only a list state of one viewer, so it does not stop messages.
- Each message has an idempotency key, so a retry does not add a second
  message.

## Waiting on you

A Conversation waits on a User when it has an open linked item that is
assigned to the User or to Everyone (`listWaitingConversationIds`). An item
with no assignees does not wait on anyone. The dashboard shows a lavender dot
for these Conversations. The dot replaces the other status markers.

## Slack cards

`chat/slack/review-item-card-sync.ts` shows each item as a card in its
linked Slack threads. `junior_review_item_slack_cards` stores the message of
each card, so Junior can change it in place.

- An open item gets a card in each linked thread that has none. A closed
  item posts no new cards.
- After each change by an agent or a person, every card shows the new
  state. A closed card has no controls and shows who closed it.
- A private item shows only in the thread that added it. Another linked
  thread can have people who cannot see its source. A card in a thread that
  can no longer show the item loses its content.
- Cards are optional UI. A Slack failure is logged and does not fail the
  change.
- Syncs of one item run one at a time under a state lock (`withLock` in
  `chat/state/locks.ts`). So two syncs cannot post two cards in one thread.
  Each sync reads the latest item, so a sync that waits shows the newest
  state. A card whose row cannot be saved is removed, so every card changes.

The card uses the `requestUserInput` controls. A request with one `choice`
field shows one button per option. Other requests show an Answer button that
opens a form. A notice shows Done. Each card also shows Dismiss.

A click comes back through `chat/ingress/slack-review-item.ts`. It needs the
same workspace and allowed domain checks as a Slack mention, and a Junior
User linked to the Slack account. The thread of the card gets the action as
Slack input from the person. The other linked Conversations get the usual
messages. Only the click that closes the item adds input, so two fast
clicks add one Turn. A click on a closed item tells the person and changes
nothing.
