# Review items

A Review item is work that needs a person. Agents add Review items. People
act on them on the review desk. See issue #2401 for the full product
behavior.

## Model

- A Review item has a kind, a status, a title, a body, and assignees.
- A `notice` only tells a person something. An `action` asks for an answer.
  Its `request` (`userInputRequestSchema`) is a question and 1-4 fields.
- An action item is the only way the agent asks a person for input.
- The status is `open`, `done`, or `dismissed`. Only a person or an agent
  closes an item. Nothing closes it on its own.
- An assignee is a User or **Everyone**. Everyone is a flag on the item. It
  means that any person who can see the item can act on it. When the agent
  names no assignee, a new item goes to the User of the Actor, or else to the
  creator of the Automation of the run. When neither has a User, such as a
  Slack Actor who has not signed in, the item has no assignees.
- An item can have a subject, such as a pull request, and links to one or
  more Conversations. The Conversation of the agent that adds the item is
  always linked. An update cannot remove that link.
- An item from an Automation run stores the Automation id. A later run of the
  same Automation can see and change it.

## Dedupe key

- Each item has a dedupe key. Without a key from the agent, the key comes
  from the tool call id, so a retry of the call updates the same item. Only
  one open item in a provider tenant can use a key. Other tenants do not see
  the key and can use it too.
- When an agent adds an item with the key of an open item, it updates that
  item. The update replaces the content and the assignees. It keeps every
  linked Conversation and adds the new one.
- After an item closes, the same key can start a new item.
- The key follows the same rules as an update. An agent that cannot change
  the open item must use a different key.

## Visibility

`access.ts` owns every rule in this section. The function for each rule is in
parentheses.

- An item is `private` when a Conversation that added or updated it is not
  public. It is `public` otherwise. No change makes a private item public.
- A private item links only to the Conversation that added it, and to later
  runs of the same Automation. It cannot be assigned to Everyone. Each
  assigned User must be the Actor, a person in the current Conversation or
  in the Conversation that added the item, or the creator of the Automation
  that added the item (`requireReviewItemAssignees`). An Automation run
  often has no Actor and no people.
- Each item stores the provider tenant, such as the Slack workspace, of the
  Conversation that added it. Every link must be in that tenant. A public
  item is visible only to readers in the same tenant. A Slack mention in
  the assignees resolves only to a User in that tenant.
- A reader can see an item when it is public in the reader's tenant, when the
  reader is an assigned User, when it is linked to the reader's Conversation,
  or when the reader's Automation added it (`canReadReviewItem`, and
  `reviewItemVisibleTo` for search). `review-item-access.test.ts` checks
  that the two give the same readers.
- The agent tools read as the Conversation, not as the Actor
  (`readReviewItemAgentScope`). An assigned
  User sees the item on the review desk. An agent in another Conversation of
  that User does not, so it cannot copy private content there.
- A public item can link other Conversations only when they are public
  (`requireReviewItemLinks`).
- An agent can change an item only from a Conversation in its tenant. It
  can change a public item only from a public Conversation. It can change a
  private item only from the Conversation or Automation that added it
  (`canAgentChangeReviewItem`). This keeps private content out of other
  Conversations.
- An agent can never submit the answer to an action item. Only an assignee
  can submit.

## Tools

`chat/tools/review-items.ts` owns the tools. `addReviewItem` is loaded in
every root Turn, because it is how the agent asks a person anything. Its
description holds the rules for when to ask and when to wait.
`updateReviewItem` and `searchReviewItems` are deferred tools in the
`review-desk` source. A child agent cannot use them. It reports to its
parent with `reportBlocked`, and the parent adds the item.

## Person actions

`actions.ts` owns what a person can do. The review desk API
(`api/review-items/routes.ts`) calls it.

- An assigned User can act on an open item. Anyone who can see the item can
  act when it is assigned to Everyone or when it has no assignees
  (`canActOnReviewItem` in `access.ts`).
- **Take** makes the person the only assignee. The item stays open. A
  retry of a take sends missing messages again.
- **Submit** saves the answer to an action item and marks it `done`.
- **Complete** marks a notice `done`. An action item needs an answer, so it
  cannot be completed.
- **Dismiss** marks any item `dismissed`.
- The first submit, complete, or dismiss closes the item for every assignee.
  The item records who closed it and when. A retry of the same close
  succeeds and sends missing messages again.

## Reply in the thread

A person can answer an action item with a message instead of the card
(`closeReviewItemsAnsweredByReply` in `actions.ts`). The message is a Slack
mention or DM to Junior, or a dashboard message, in a Conversation. Junior
saves the message first, so it always reaches the agent. Then it closes each
item that matches all of these:

- The item is an open `action` item.
- The agent added it in this Conversation (`addedByConversationId`). Items
  that are only linked to the Conversation stay open.
- The person is an assigned User, or the item has no assignees.

An item assigned to Everyone, or only to other people, stays open. The
item closes as `done` with the reason `Replied in thread`, and the person
closes it. The item saves the message text as its `answer`, in the `other`
field. Junior first removes a Slack mention of Junior at the start of the
message. A Slack person without a Junior User closes only items with no
assignees. The message is the answer in its own Conversation. Each other
linked Conversation gets an Event. The first close wins, so a reply after a
click changes nothing. A retry of the reply, or a later reply from the same
person, delivers again each item that the person closed by reply. The cards
show the close again, and only the missing Events go. Each Event has a key,
so an Event that was sent does not go again.

## After a change

Every change goes through one path: `deliverReviewItemChange` in
`changes.ts`. The agent tools, the person actions, and a reply in the
thread call it after they save the change.

- First, every surface shows the new state. App setup gives the `show`
  function. Today it is the Slack card sync. Review item code does not import
  Slack code (`no-review-items-to-slack` in `.dependency-cruiser.mjs`).
- Then a person action or an agent close goes to the other linked
  Conversations as messages. An agent change to the content sends no
  messages.
- Delivery runs inline, after the change is saved. A failed message fails the
  call that made the change. The caller can retry: a retry sends only the
  messages that are missing. A failed card is logged. The next delivery of
  the item shows its latest state.
- App setup also gives the agent tools `findMentionedUserId`. The Slack
  version (`chat/slack/review-item-tools.ts`) resolves a Slack mention to a
  User through the Slack Identity in the workspace of the item.

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
  message. A retry of the same agent close, with the same status and
  reason, sends missing messages again.

## Waiting on you

An item needs a User when it is an open `action` item and the User is an
assignee (`reviewItemNeedsUser` in `access.ts`). A notice, an item assigned
to Everyone, and an item with no assignees need no one. One rule gives both
of these:

- The count in the dashboard nav (`needsViewer` from
  `/api/review-items/count`).
- The "Waiting on you" marker. A Conversation waits on a User when it is
  linked to an item that needs the User (`listWaitingConversationIds`). The
  dashboard shows a lavender dot for these Conversations. The dot replaces
  the other status markers.

The review desk list shows more: every open item that the reader can see.

## Slack cards

`chat/slack/review-item-card-sync.ts` shows each item as a card in its
linked Slack threads. `junior_review_item_slack_cards` stores the message of
each card, so Junior can change it in place.

- An open item gets a card in each linked thread that has none. A closed
  item posts no new cards.
- After each change by an agent or a person, every card shows the new
  state. A closed card has no controls and shows who closed it.
- A card in a thread that the item is no longer linked to loses its
  content.
- Cards are optional UI. A Slack failure is logged
  (`review_item.slack_card.sync.failed`) and does not fail the change.
- Syncs of one item run one at a time under a state lock (`withLock` in
  `chat/state/locks.ts`). So two syncs cannot post two cards in one thread.
  Each sync reads the latest item, so a sync that waits shows the newest
  state. A card whose row cannot be saved is removed, so every card changes.

The card uses the request controls in `chat/slack/user-input.ts`. A request
with one `choice` field shows one button per option. Other requests show an Answer button that
opens a form. A notice shows Done. Each card also shows Dismiss.

A click comes back through `chat/ingress/slack-review-item.ts`. It needs the
same workspace and allowed domain checks as a Slack mention, and a Junior
User linked to the Slack account. The card row names the Conversation of
the card, because an Automation run can own a thread under an id that is
not a Slack thread id. That Conversation gets the action as Slack input
from the person. A choice button carries its label. A click on a stale card
whose label the item no longer offers changes nothing. The other linked Conversations get the usual
messages. Only the click that closes the item adds input, so two fast
clicks add one Turn. A click on a closed item tells the person and changes
nothing.
