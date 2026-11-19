# Notifications

Junior interrupts a person only when that person has a clear next step. All
other work happens with no message, Review item, or count. This rule decides
how Slack, the Review desk, the Inbox, and each plugin tell people about work.

## Intent

- Each notification names a next step for the person who gets it. A
  notification with no next step costs attention and teaches people to
  ignore Junior.
- A person hears back at the end of their request: the answer to their
  question, the result of their task, or, when Junior is stuck, what they
  must do to unblock it.
- Junior owns the upkeep of its own work, such as merge conflicts, failed
  checks, and review feedback on its pull requests. That work goes to the
  agent, which does it and tells nobody.
- For a pull request, the next step is a review. Junior gets the required
  checks green and marks it ready for review. Only then does it ask the
  requester to review it.
- Slack and the dashboard notify about the same things. The dashboard can
  show more detail, but not more notifications.

## Entry points

- Slack: a reply in the thread of the request, and a Review item card.
- Dashboard: Inbox, the Inbox count in the tab, and "Needs you".
- GitHub: a review request on a pull request that Junior opened.

## Rules

- An Event about work that Junior owns starts a Turn for the agent, not a
  notification. When the agent finishes that work, it ends the Turn with no
  reply.
- A Turn that an Event starts posts only when a person must decide or act.
  An Automation posts what its instruction asks for.
- Progress, status, and FYIs are not notifications. When Junior stops
  upkeep that it owns, such as fixes on a pull request that nobody works
  on, it tells nobody.
- When Junior is blocked, it says what the person must do. "Junior stopped"
  with nothing to do is not a notification.
- A Review item is the only way to ask a person
  ([Review desk](./review-desk.md)).

## Gaps

- An agent can add a notice Review item that names no next step. This
  breaks "each notification names a next step".
- Junior counts its own merges and force pushes for requested work as
  merge conflict fixes. So the fix limit can stop fixes on a pull request
  that people still work on. This breaks "Junior owns the upkeep of its own
  work".
