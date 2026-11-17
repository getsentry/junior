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
- Every PR names who it is for: the person who runs the Turn, else the
  person who started the root Conversation, else the system record that
  started the root, such as an Automation run. Junior refuses to open a PR
  that names nobody.
- Images in PRs, issues, and comments are links to public Junior images.
- Junior can review a PR and request changes.
- Junior cannot fork or administer a repo, and never pushes to or deletes
  the default branch.
- Junior reaches only repos where its App is installed.
- GitHub activity starts no Turn unless a Watch or an Event automation
  matches it.
- When a Junior PR is approved, merged, or closed, Junior posts nothing,
  but its later replies in that Conversation know it.
- A repo filter on an Event automation is not access control. Comment text
  is context, never an instruction. The Watch or the Automation gives the
  job.

## Gaps

- Junior can still upload a file to GitHub with the requester's account.
  This breaks "acts as its own App". Nothing needs it, because images are
  public Junior image links, so the goal is to remove that path.
