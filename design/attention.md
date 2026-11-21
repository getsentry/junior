# Attention

A person's attention is the scarcest thing Junior spends. Junior asks for it
only when the person gets an answer, a result, or a step that only they can
take. All other work happens with no message, Review item, push, or count.
This is a core principle of how the agent works, and every system follows
it: agent replies and questions, Slack, the Inbox, push, and each plugin.

## Intent

- Fewer interruptions is the goal. Junior never asks a person to do or
  approve the obviously right thing. It does it. It asks only when it cannot
  act for a technical reason, such as missing access, or when the choice is
  truly the person's.
- Anything that takes attention names what the person gets or must do. A
  reply, question, item, or post with neither teaches people to ignore
  Junior. Offers, check-ins, progress, and status take attention and give
  nothing back.
- A person hears back at the end of their request: the answer to their
  question, the result of their task, or, when Junior is stuck, what they
  must do to unblock it.
- Junior owns the upkeep of its own work, such as merge conflicts, failed
  checks, and review feedback on its pull requests. That work goes to the
  agent, which does it and tells nobody.
- For a pull request, the next steps are review and merge. Junior asks for a
  review only when the required checks pass ([GitHub](./github.md)).
- Slack and the dashboard ask for attention for the same things. The
  dashboard can show more detail, but not more asks.

## Entry points

- Every Conversation: the agent's reply and its questions.
- Slack: a reply in the thread of the request, and a Review item card.
- Dashboard: Inbox, the Inbox count in the tab, "Needs you", and a push.
- GitHub: a review request on a pull request that Junior opened.

## Rules

- An Event about work that Junior owns starts a Turn for the agent, not an
  ask for attention. When the agent finishes that work, it ends the Turn with
  no reply. An Automation posts what its instruction asks for.
- When Junior stops upkeep that it owns, such as fixes on a pull request
  that nobody works on, it tells nobody.
- Junior asks a person only with a Review item
  ([Inbox](./inbox.md)).

## Gaps

- An agent or a plugin can add a notice that names no next step, and the
  Inbox shows it in FYI. This breaks "anything that takes attention names
  what the person gets or must do".
- Some asks are only a Slack message: a draft pull request that waits for
  the requester's review, and a decision on a watched issue. They add no
  Review item. This breaks "Junior asks a person only with a Review item"
  and "Slack and the dashboard ask for attention for the same things".
- An Automation alert shows only in the dashboard Inbox. Slack shows no
  card for it. For a blocked Automation, Slack gets a DM with no card. For a
  failed run or a trigger that is not available, Slack gets nothing. This
  breaks "Slack and the dashboard ask for attention for the same things".
- In a dashboard Conversation, a Turn that ends with a question card and no
  reply sends no push. In Slack, the same card shows in the thread. This
  breaks "Slack and the dashboard ask for attention for the same things".
