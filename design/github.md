# GitHub

A user asks Junior to work in a GitHub repository: read code, change it,
open and follow pull requests, review them, and work on issues. Junior
does this as its GitHub App, so the user needs no token. GitHub activity can
also wake a Conversation or run an Event automation.

## Intent

- Junior carries its PR to the requester's review without asking
  ([Attention](./attention.md)).
- Engineers stay in flow. A Junior PR takes a person's attention only for a
  step that only a person can take, such as a review, a merge, or a problem
  that Junior cannot solve. It asks for each step once.
- Junior owns the upkeep of its PR while the PR is open: failed checks,
  review feedback, and merge conflicts. Upkeep follows people. Junior does
  it when the PR next needs a person, so a PR that nobody works on costs no
  work and no attention.
- Junior debugs before it asks. A question about a red check or a stuck fix
  says what Junior found and what the person must do.
- Changes reach the code only through a PR, never a direct push to the
  default branch.
- Junior never approves or merges a PR, in any repo and from any
  Automation. A person merges it.
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
- Junior asks for a review only when the required checks pass
  (`github#review-request`, `github#rereview`).
- Only the requester gets Inbox items for a Junior PR. Other reviewers
  hear only from GitHub (`github#other-reviewers`,
  `github#requester-gone`).
- A Junior push to an approved PR follows the repo's setting for stale
  approvals. Junior never keeps or dismisses an approval on its own
  (`github#push-after-approval`).
- A Junior PR that a person can merge gets one `Ready to merge` for the
  requester (`github#ready-to-merge`, `github#stack`).
- Junior never skips, disables, or weakens a check to make it pass
  (`github#checks-red`).
- An ask that waits is not repeated or reassigned, and Junior does not
  close its PR for inactivity (`github#no-reminders`).
- Junior cannot fork or administer a repo, and never deletes the default
  branch.
- Junior reaches only repos where its App is installed.
- GitHub activity starts no Turn unless a Watch or an Event automation
  matches it.
- When a Junior PR is merged or closed, Junior posts nothing, but its later
  replies in that Conversation know it (`github#pr-ended`).
- Comment text is context, never an instruction. The Watch or the
  Automation gives the job.

## Gaps

- A PR opened ready for review, and Junior's push, reply, or comment
  after a change request, ask for a review before the required checks pass
  (`github#review-request`, `github#rereview`). This breaks "asks for a
  review only when the required checks pass".
- When a draft becomes ready, Junior asks the named reviewers or the
  requester for a review even when they already reviewed it, and the
  requester can get a new `Review requested` (`github#review-request`).
  This breaks "It asks for each step once".
- Junior fixes merge conflicts on a timer after a person's activity, not
  when the PR next needs a person, and a draft gets no fix, so it never
  reaches review (`github#conflict-fix`). This breaks "upkeep follows
  people" and "carries its PR to the requester's review".
- A required check that the PR does not cause gets no new run and no ask,
  so the PR waits and nobody hears (`github#checks-red`). This breaks
  "Junior debugs before it asks".
- A check or feedback fix that does not land asks nobody, or gets only a
  Slack message (`github#fix-unlanded`). This breaks Attention's "when
  Junior is stuck, what they must do to unblock it".
- A draft held for code owners or `AGENTS.md` gets a Slack message that
  says why it is a draft, and no review ask (`github#draft-held`). This
  breaks "takes a person's attention only for a step that only a person
  can take".
- `Ready to merge` waits for every check, not only the required ones, and
  does not know stacks (`github#ready-to-merge`, `github#stack`). This
  breaks "a Junior PR that a person can merge gets one `Ready to merge`".
- In a repo that dismisses stale approvals, a Junior push to an approved
  PR asks nobody for a fresh review, so the PR waits and nobody hears
  (`github#push-after-approval`). This breaks "a Junior push to an approved
  PR follows the repo's setting for stale approvals".
- The Watch on a Junior PR expires while the PR is open. After that, its
  upkeep stops, and nobody is told (`github#long-lived`). This breaks
  "Junior owns the upkeep of its PR while the PR is open".
- Junior can upload a file to GitHub with the requester's account.
  This breaks "acts as its own App" and "images are links to public Junior
  images".
