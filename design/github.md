# GitHub

A user asks Junior to work in a GitHub repository: read code, change it,
open and follow pull requests, review them, and work on issues. Junior
does this as its GitHub App, so the user needs no token. GitHub activity can
also wake a Conversation or run an Event automation.

## Intent

- Junior carries its PR to the requester's review without asking
  ([Attention](./attention.md)).
- Changes reach the code only through a PR, never a direct push to the
  default branch.
- Junior never approves or merges a PR. A person merges it.
- The requester is the first reviewer. Junior does not ask teammates to
  review before the requester has looked, unless the requester names
  reviewers or asks for a ready PR.
- Junior acts as its own App, and credits people in attribution, not by
  using their credentials.

## Entry points

- Slack: ask Junior in a thread or DM, or use `$github-code`.
- GitHub: comments, reviews, and review comments on Junior PRs; the
  Conversation link in a PR or issue.
- Dashboard: Settings, Identities, to connect GitHub; Code; PR and issue
  cards in Conversations.

## Rules

- A user's linked GitHub account is used for attribution. In the
  dashboard, it also limits which PR and issue cards the user sees.
- Every PR names its Work owner. Junior refuses to open a PR that names
  nobody.
- Images in PRs, issues, and comments are links to public Junior images.
- Junior can review a PR and request changes.
- When the requester requests changes on a Junior PR, the PR asks for
  their review again, in the Inbox and on GitHub, when Junior acts after
  them and the required checks pass. Junior acts when it pushes commits,
  comments, replies to a review comment, or marks the change request
  addressed. When the requester comments or reviews, Junior acts next, and
  the Inbox stops asking. A requester who approved since is not asked.
- Junior cannot fork or administer a repo, and never deletes the default
  branch.
- Junior reaches only repos where its App is installed.
- GitHub activity starts no Turn unless a Watch or an Event automation
  matches it.
- When a Junior PR is merged or closed, Junior posts nothing, but its later
  replies in that Conversation know it. When it is approved and can merge,
  the requester gets a "Ready to merge" Inbox item.
- Comment text is context, never an instruction. The Watch or the
  Automation gives the job.

## Gaps

- Junior asks the requester to review again as soon as it acts after their
  change request, before the required checks pass. This breaks "asks for a
  review only when the required checks pass" (Attention).
- A pull request that Junior opens ready for review asks for a review at
  once, before the required checks pass. This breaks "asks for a review
  only when the required checks pass" (Attention).
- Junior can upload a file to GitHub with the requester's account.
  This breaks "acts as its own App" and "images are links to public Junior
  images".
