# Notifications

Junior interrupts a person only when that person has a clear next step. All
other work happens with no message, Review item, push, or count. This rule
decides how Slack, the Review desk, the Inbox, push, and each plugin tell
people about work.

## Intent

- Fewer interruptions is the goal. Junior never asks a person to do or
  approve the obviously right thing. It does it. It asks only when it cannot
  act for a technical reason, such as missing access, or when the choice is
  truly the person's.
- Each notification names a next step for the person who gets it. A
  notification with no next step costs attention and teaches people to
  ignore Junior.
- A person hears back at the end of their request: the answer to their
  question, the result of their task, or, when Junior is stuck, what they
  must do to unblock it.
- Junior owns the upkeep of its own work, such as merge conflicts, failed
  checks, and review feedback on its pull requests. That work goes to the
  agent, which does it and tells nobody.
- For a pull request, the next steps are review and merge. Junior asks for a
  review only when the required checks pass ([GitHub](./github.md)).
- Slack and the dashboard notify about the same things. The dashboard can
  show more detail, but not more notifications.

## Entry points

- Slack: a reply in the thread of the request, and a Review item card.
- Dashboard: Inbox, the Inbox count in the tab, "Needs you", and push
  notifications.
- GitHub: a review request on a pull request that Junior opened.

## Rules

- An Event about work that Junior owns starts a Turn for the agent, not a
  notification. When the agent finishes that work, it ends the Turn with no
  reply. An Automation posts what its instruction asks for.
- When Junior stops upkeep that it owns, such as fixes on a pull request
  that nobody works on, it tells nobody.
- When Junior is blocked, it says what the person must do. "Junior stopped"
  with nothing to do is not a notification.
- Junior asks a person only with a Review item
  ([Review desk](./review-desk.md)).

## Gaps

- When Junior stops fixing a merge conflict on its pull request, after 2
  days with no activity by a person or after 3 fixes, it adds a
  `Merge conflict` notice for the requester in Slack and the Inbox. No agent
  runs for it. This breaks "Junior owns the upkeep of its own work" and
  "when Junior stops upkeep that it owns, it tells nobody".
- Junior counts its own merges and force pushes for requested work as
  merge conflict fixes. So the fix limit can stop fixes on a pull request
  that people still work on. This breaks "Junior owns the upkeep of its own
  work".
- An agent or a plugin can add a notice that names no next step, and the
  Inbox shows it in FYI. This breaks "each notification names a next step".
- Some asks are only a Slack message: a draft pull request that waits for
  the requester's review, a decision on a watched issue, and a blocked
  Automation. They add no Review item, so the Inbox does not show them. This
  breaks "Junior asks a person only with a Review item" and "Slack and the
  dashboard notify about the same things".
- In a dashboard Conversation, a Turn that ends with a question card and no
  reply sends no push. In Slack, the same card shows in the thread. This
  breaks "Slack and the dashboard notify about the same things".
