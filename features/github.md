# GitHub

A user asks Junior to work in a GitHub repository: read code, change it,
open and follow pull requests, review them, and work on issues. Junior
does this as its GitHub App, so the user needs no token. GitHub activity can
also wake a Conversation or run an Event automation.

## Intent

- Junior carries its PR to the requester's review without asking. It posts
  in Slack only when a person must decide or act.
- Changes reach the code only through a PR, never a direct push to the
  default branch.
- For now, Junior never approves or merges a PR. A person merges it. Later
  policies can let Junior merge some PRs.
- The requester is the first reviewer. Junior does not ask teammates to
  review before the requester has looked.
- Junior acts as its own App, and credits people in attribution, not by
  using their credentials.

## Behaviors

- `pr-draft` A user asks for a code change. Junior pushes a branch and opens
  a draft PR without asking first, unless the user asks for a ready PR or
  for investigation only.
- `pr-assign` A new PR is assigned to the requester's linked GitHub account
  and asks them, or the reviewers they named, to review it when it is ready.
- `attribution` PRs and issues that Junior creates name the requester and
  link back to the Conversation.
- `pr-follow` After Junior opens a PR, it fixes failed checks and review
  feedback, and replies on GitHub. It fixes merge conflicts on an active PR,
  and adds a Review item for the requester on an idle one.
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

- A user's linked GitHub account is used for attribution and for what they
  can see.
- Images in PRs, issues, and comments are links to public Junior images.
- Junior can review a PR and request changes.
- Junior cannot fork or administer a repo, and never pushes to or deletes
  the default branch.
- Junior reaches only repos where its App is installed.
- GitHub activity does nothing unless a Watch or an Event automation
  matches it.
- A repo filter on an Event automation is not access control. Comment text
  from GitHub is untrusted.

## Gaps

- Junior can still upload a file to GitHub with the requester's account.
  This breaks "acts as its own App". Nothing needs it, because images are
  public Junior image links, so the goal is to remove that path.
