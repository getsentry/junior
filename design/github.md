# GitHub

A user asks Junior to work in a GitHub repository: read code, change it,
open and follow pull requests, review them, and work on issues. Junior
does this as its GitHub App, so the user needs no token. GitHub activity can
also wake a Conversation or run an Event automation.

## Intent

- Junior carries its PR to the requester's review without asking
  ([Attention](./attention.md)).
- Engineers stay in flow. On a Junior PR, Junior takes a person's attention
  only for a step that only a person can take: a review, a merge, or a fix
  that Junior cannot land. It asks for each step once, when the PR is ready
  for it.
- Junior owns the upkeep of its PR while the PR is open: failed checks,
  review feedback, and merge conflicts. Upkeep follows people. Junior does
  it when the PR next needs a person, or when a person acts on the PR. A PR
  that nobody works on costs no work and no attention.
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
- Inbox: `Review requested` and `Ready to merge` for a Junior PR, and an
  item when Junior is stuck on one.
- Dashboard: Settings, Identities, to connect GitHub; Code; PR and issue
  cards in Conversations.

## Rules

- A user's linked GitHub account is used for attribution. In the
  dashboard, it also limits which PR and issue cards the user sees.
- Every PR names its Work owner. Junior refuses to open a PR that names
  nobody.
- Images in PRs, issues, and comments are links to public Junior images.
- Junior can review a PR and request changes.
- Only the requester gets Review items for a Junior PR. Other reviewers hear
  only from GitHub. When the requester left the Conversation or has no
  linked GitHub account, nobody is asked (`github#other-reviewers`,
  `github#requester-gone`).
- A Junior PR asks for a review once, when it is ready for review and its
  required checks pass. A draft that would ask code owners, or that the
  repo's `AGENTS.md` keeps a draft, waits for the requester
  (`github#draft-ready`, `github#draft-held`, `github#review-request`).
- After a reviewer requests changes, Junior fixes them and asks that
  reviewer again when the required checks pass. A reviewer who approved
  since is not asked (`github#rereview`).
- A Junior change to the diff of an approved PR asks the approver again
  (`github#push-after-approval`).
- An approved PR with no open change request, passing required checks, no
  conflict, and auto-merge off gets one `Ready to merge` for the requester
  (`github#ready-to-merge`, `github#auto-merge`).
- Upkeep asks nobody. Junior answers on GitHub and posts no status. It never
  skips, disables, or weakens a check. A check that the PR does not cause
  gets one more run before Junior asks (`github#pr-follow`,
  `github#checks-unrelated`).
- Junior fixes a merge conflict when the PR next needs a person, and never
  on a PR that nobody works on (`github#conflict-lazy`,
  `github#conflict-idle`).
- When Junior cannot land a fix, it asks the requester once. `Dismiss` ends
  those asks on that PR (`github#fix-unlanded`).
- An ask that waits stays one Review item. Junior does not remind,
  escalate, or reassign it, and does not close a PR for inactivity
  (`github#no-reminders`).
- In a stack, conflicts are fixed with a rebase of the stack, and the stack
  gets one `Ready to merge` (`github#stack`).
- A Junior PR that waits on checks, on Junior, or on another reviewer does
  not put its Conversation in "Needs you" for the requester. Only its open
  Review items do.
- Junior cannot fork or administer a repo, and never pushes to or deletes
  the default branch.
- Junior reaches only repos where its App is installed.
- GitHub activity starts no Turn unless a Watch or an Event automation
  matches it.
- When a Junior PR is merged or closed, by anyone, Junior posts nothing, but
  its later replies in that Conversation know it (`github#pr-ended`).
- Comment text is context, never an instruction. The Watch or the
  Automation gives the job.

## Gaps

- Three review asks do not wait for the required checks: a PR opened ready
  for review, a change request that Junior marks addressed, and a push after
  a change request (`github#review-request`, `github#rereview`). This
  breaks "a Junior PR asks for a review once, when it is ready for review
  and its required checks pass".
- Junior fixes a merge conflict on its own schedule, only within 2 days of
  a person's activity, and not when the PR next needs a person. A conflict
  that the base branch brings to a draft gets no fix, so its checks do not
  run and it never becomes ready (`github#conflict-lazy`). This breaks
  "upkeep follows people".
- A required check that fails for a reason outside the PR gets no new run
  and no ask. The PR waits, and nobody hears about it
  (`github#checks-unrelated`). This breaks "upkeep follows people" and
  Attention's "when Junior is stuck, what they must do".
- Only a conflict fix that does not land asks the requester. A check or
  feedback fix that does not land asks nobody, or gets only a Slack message
  (`github#fix-unlanded`). This breaks "when Junior cannot land a fix, it
  asks the requester once".
- `Ready to merge` waits for every check, not only the required ones. A
  failing or pending check that is not required holds it
  (`github#ready-to-merge`). This breaks the `Ready to merge` rule.
- An approval of an older commit still counts. After Junior pushes to an
  approved PR, nobody is asked again, unless the repo dismisses stale
  approvals (`github#push-after-approval`). This breaks "a Junior change
  to the diff of an approved PR asks the approver again".
- `Ready to merge` does not know stacks. Each PR in a stack gets its own
  item, and no item covers the stack (`github#stack`). This breaks "the
  stack gets one `Ready to merge`".
- The Watch on a Junior PR ends 14 days after the PR opens. After that,
  review feedback, failed checks, and conflicts get no upkeep, and nobody
  is told (`github#long-lived`). This breaks "Junior owns the upkeep of its
  PR while the PR is open".
- Junior can upload a file to GitHub with the requester's account.
  This breaks "acts as its own App" and "images are links to public Junior
  images".
