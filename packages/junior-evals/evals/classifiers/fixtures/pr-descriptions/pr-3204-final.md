Fixes #3207

Label-triggered SDK repro runs (`sdk-bug-repro`, getsentry/junior-prod#669) need a start signal on the issue, plus one progress comment that the run edits as it goes. The runtime egress policy denies the raw endpoints for both ("This GitHub write request is not supported"):

- `POST /repos/{owner}/{repo}/issues/{n}/reactions`
- `PATCH /repos/{owner}/{repo}/issues/comments/{id}`

This adds two GitHub plugin tools:

- `github_updateIssueComment` `{ repo, comment_id, body }` replaces the body of an issue or PR conversation comment. It reads the comment first and refuses unless the bot posted it.
- `github_reactToIssue` `{ repo, number, content }` adds a reaction to the issue or PR itself. `content` is GitHub's reaction enum. GitHub returns the existing reaction on a repeat, so the call is idempotent.

Egress allows each endpoint only with its tool's egress operation (`github.issue.comment.update`, `github.issue.reaction.create`). Sandbox `gh api` calls stay denied, and the message names the tool. `DELETE` on issue comments stays unsupported.
