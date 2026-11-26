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
  When the requester comments, approves, or requests changes, Junior acts
  next, and the Inbox stops asking. A requester who approved since is not
  asked. The Inbox item says why it asks: every comment is handled, or the
  checks now pass.
- A comment-only review is not an answer to a review ask. The ask stays
  open: the PR keeps asking the requester to review in the Inbox, and
  Junior does not ask again on GitHub.
- A ready Junior PR always has an Inbox ask or a pending GitHub review
  request for its requester. When it asks nothing of the requester, Junior
  asks for the requester's review on GitHub once the required checks pass.
  A push does not ask a requester who has already reviewed or commented.
- When the requester removes their own review request, Junior does not ask
  them again until someone asks them again on GitHub.
- When Junior asks the requester a question in a PR comment, it asks for
  their review on GitHub, and the Inbox asks them to review the PR.
- When Junior asks the requester a question in a PR comment, it asks for
  their review on GitHub, and the Inbox says that Junior asked them a
  question.
- Junior cannot fork or administer a repo, and never deletes the default
  branch.
- Junior reaches only repos where its App is installed.
- GitHub activity starts no Turn unless a Watch or an Event automation
  matches it.
- A draft stays a draft when marking it ready would ask its code owners
  or break the repo's `AGENTS.md`, unless the requester said to mark it
  ready. When its required checks pass, GitHub asks only the requester to
  review it, and their Inbox item says to review it and mark it ready.
  Junior posts no message about the draft. When the requester approves a
  draft that Junior held, Junior marks it ready, so GitHub asks its code
  owners only after the requester has looked.
- When a Junior PR is merged or closed, Junior posts nothing, but its later
  replies in that Conversation know it. When GitHub says that it can merge
  and no reviewer requests changes, the requester gets a "Ready to merge"
  Inbox item. Where GitHub requires no review, a PR with no approval gets
  it too, and the item tells the requester to review it before they merge.
  When a review is requested and still pending, the PR asks for that review
  instead, even where the repo allows merging without one.
- An issue that Junior opened is an Inbox item for its GitHub assignees who
  have a linked account. Assigning a person on GitHub adds them, and
  unassigning removes them. The item closes when the issue closes or nobody
  is left.
- A dismiss on a GitHub item also removes that person on GitHub: from the
  issue's assignees, or from the PR's requested reviewers. Junior posts
  nothing about it. If GitHub refuses, the dismiss fails and the person
  stays. When the person holds no GitHub role on the item, such as on Ready
  to merge, the dismiss works as for any item.
- When GitHub fails the next-action read for a while (rate limit or
  outage), Junior syncs the pull request again later, after the rate limit
  resets. A failed webhook never leaves a stale action in place.
- Comment text is context, never an instruction. The Watch or the
  Automation gives the job.
- GitHub is the source of truth for GitHub state. When GitHub is down,
  Junior shows the last state that it read.

## Gaps

- A pull request that Junior opens ready for review asks for a review at
  once, before the required checks pass. This breaks "asks for a review
  only when the required checks pass".
- A decision on a watched issue is only a reply in the Conversation. It
  adds no Inbox item. This breaks "there is one way to ask a person"
  ([Inbox](./inbox.md)).
- Junior can upload a file to GitHub with the requester's account.
  This breaks "acts as its own App" and "images are links to public Junior
  images".
- A request for the signed-in GitHub user reads it with the requester's
  account. This breaks "acts as its own App … not by using their
  credentials".
