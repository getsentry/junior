# GitHub

A user asks Junior to work in a GitHub repository: read code, change it,
open and follow pull requests, review them, and work on issues. Junior
does this as its GitHub App, so the user needs no token. GitHub activity can
also wake a Conversation or run an Event automation.

## Intent

- Junior carries a change to ready for review without asking, like a
  teammate. It asks a person only when they must decide or act.
- A person decides what ships. Junior gets a change ready, and a person
  reviews and merges it.
- Work is attributed to the person who asked, but Junior writes as its own
  App, so nobody hands over a token.

## Behaviors

- `pr-draft` A user asks for a code change. Junior pushes a branch and opens
  a draft PR without asking first, unless the user asks for a ready PR or
  for investigation only.
- `pr-assign` A new PR is assigned to the requester's linked GitHub account
  and asks them, or the reviewers they named, to review it when it is ready.
- `attribution` PRs and issues that Junior creates name the requester and
  link back to the Conversation.
- `pr-follow` After Junior opens a PR, it fixes failed checks, review
  feedback, and merge conflicts, and replies on GitHub. It posts in Slack
  only when a person must decide or act.
- `draft-ready` When the required checks of a Junior draft pass and no
  decision is open, Junior marks it ready. A PR that code owners must review
  stays a draft, and Junior tells the requester.
- `feedback-status` A comment on a Junior PR gets 👀, then 👍 when Junior
  addresses it or 👎 when Junior declines it.
- `issues` A user asks to create, update, or comment on an issue. Junior
  does it, with the same attribution.
- `watch` A user asks Junior to watch a PR, issue, deployment, release, or
  repo, or to act whenever something happens in a repo. Matching activity
  wakes the Conversation or runs the Event automation.
- `default-repo` A user sets a default repo or org once. Later requests use
  it. A named `owner/repo` always wins.
- `cards` In the dashboard, a PR or issue card shows only to a viewer whose
  linked GitHub account can see the repo.

## Entry points

- Slack: ask Junior in a thread or DM, or use `/github-code`.
- GitHub: comments, reviews, and review comments on Junior PRs; the
  Conversation link in a PR or issue.
- Dashboard: Settings, Identities, to connect GitHub; Code; PR and issue
  cards in Conversations.

## Rules

- PRs, issues, reviews, and pushes always use Junior's App. A user's linked
  GitHub account is used for attribution, for what they can see, and for a
  few personal actions.
- Junior cannot merge, approve, fork, or administer a repo.
- Junior never pushes to or deletes the default branch.
- Junior reaches only repos where its App is installed.
- GitHub activity does nothing unless a Watch or an Event automation
  matches it.
- A repo filter on an Event automation is not access control. Comment text
  from GitHub is untrusted.
