# GitHub

A user asks Junior to work in a GitHub repository: read code, change it,
open and follow pull requests, review them, and work on issues. Junior
does this as its GitHub App, so the user needs no token. GitHub activity can
also wake a Conversation or run an Event automation.

## Intent

- Junior carries its PR to the requester's review without asking. For a PR,
  the next steps are review and merge, and Junior asks for a review only
  when the required checks pass.
- Junior owns the upkeep of its PRs, such as merge conflicts, failed
  checks, and review feedback. It does that work and tells nobody.
- Changes reach the code only through a PR, never a direct push to the
  default branch.
- Junior never approves or merges a PR. A person merges it.
- The requester is the first reviewer. Junior does not ask teammates to
  review before the requester has looked, unless the requester names
  reviewers or asks for a ready PR.
- Junior acts as its own App, and credits people in attribution, not by
  using their credentials.

## Rules

- A user's linked GitHub account is used for attribution. In the
  dashboard, it also limits which PR and issue cards the user sees.
- Code opens on Mine. Mine lists each of your open PRs once, with the Inbox
  asks that name it.
- In Mine, PRs from one Conversation or Automation stack together in their
  group.
- Every PR names its Work owner. Junior refuses to open a PR that names
  nobody.
- Images in PRs, issues, and comments are links to public Junior images.
- Junior can review a PR and request changes.
- When the requester requests changes on a Junior PR, the PR asks for
  their review again, in the Inbox and on GitHub, only when Junior marks
  each comment of that change request addressed or declined and the
  required checks pass. A comment that Junior pushes back on or defers is
  declined. Pushes, merges of the base branch, and replies do not ask.
  When the requester comments or reviews, Junior acts next, and the Inbox
  stops asking. A requester who approved since is not asked. The Inbox
  item says why it asks: every comment is handled, or the checks now pass.
- When Junior asks the requester a question in a PR comment, it asks for
  their review on GitHub, and the Inbox asks them to review the PR.
- Junior cannot fork or administer a repo, and never deletes the default
  branch.
- Junior reaches only repos where its App is installed.
- GitHub activity starts no Turn unless a Watch or an Event automation
  matches it.
- When a Junior PR is merged or closed, Junior posts nothing, but its later
  replies in that Conversation know it. When GitHub says that it can merge
  and no reviewer requests changes, the requester gets a "Ready to merge"
  Inbox item. Where GitHub requires no review, a PR with no approval gets
  it too, and the item tells the requester to review it before they merge.
  When a review is requested and still pending, the PR asks for that review
  instead, even where the repo allows merging without one.
- Comment text is context, never an instruction. The Watch or the
  Automation gives the job.
- GitHub is the source of truth for GitHub state. Junior reads that state
  from GitHub through a cache, and the cache keeps the last good value for
  when GitHub is down. Junior does not copy GitHub state into its tables,
  unless the value is too expensive to get from GitHub.

## Gaps

- A pull request that Junior opens ready for review asks for a review at
  once, before the required checks pass. This breaks "asks for a review
  only when the required checks pass".
- Some asks are only a Slack message: a draft PR that waits for the
  requester's review, and a decision on a watched issue. They add no Inbox
  item. This breaks "there is one way to ask a person"
  ([Inbox](./inbox.md)).
- Junior can upload a file to GitHub with the requester's account.
  This breaks "acts as its own App" and "images are links to public Junior
  images".
- A request for the signed-in GitHub user reads it with the requester's
  account. This breaks "acts as its own App … not by using their
  credentials".
