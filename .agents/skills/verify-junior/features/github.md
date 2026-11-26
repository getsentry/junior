# GitHub

A user asks Junior to work in a GitHub repository: read code, change it, open and follow pull requests, and work on issues. Junior does this as its GitHub App, so the user needs no token. GitHub activity can wake a Conversation that watches it. Intent and rules: `design/github.md`.

## Sub-features

- `pr-draft` A user asks for a code change. Junior pushes a branch and opens a draft PR without asking first.
- `pr-assign` The new PR is assigned to the user's linked GitHub account, and review goes to the user or the reviewers they named when it is ready.
- `attribution` The body of a PR or issue that Junior creates names the requester and links back to the Conversation.
- `pr-follow` A check fails or a person leaves review feedback on a Junior PR. Junior pushes a fix and replies on GitHub.
- `draft-ready` The required checks of a Junior draft pass and no decision is open. Junior marks it ready.
- `feedback-status` A person comments on a Junior PR. The comment gets 👀, then 👍 when Junior addresses it or 👎 when Junior declines it.
- `issues` A user asks to create, update, or comment on an issue. Junior does it, with the same attribution.
- `watch` A user asks Junior to watch a PR. Matching activity wakes the Conversation, and Junior does not poll.
- `default-repo` A user sets a default repo once. Later requests use it, and a named `owner/repo` wins.
- `cards` A Conversation that links a PR or issue shows its card only when the viewer's linked GitHub account can see the repo.
- `pr-ended` A Junior PR merges or closes. Its Inbox item closes: done when it merged, dismissed when it closed.
- `pr-merge` A Junior PR is open, not a draft, with auto-merge off, no pending review, and no requester feedback that waits for Junior. GitHub says that it can merge, and no reviewer requests changes. The requester gets "Ready to merge" when their repository role can merge. While GitHub still computes the merge state, the item stays as it is.
- `pr-merge-reviewer` A Junior PR is approved, GitHub says that it can merge, it is not a draft, and auto-merge is off. A reviewer whose review GitHub still requests, and whose repository role can merge, gets "Ready to merge".
- `pr-review-again` Junior handles every comment of the requester's change request, and the required checks pass. The requester gets "Review requested" again, with the reason. On a draft, the item says to review it, then mark it ready for review.
- `pr-review` GitHub requests a person's review on a Junior PR. They get "Review requested", and Dismiss removes them from the reviewers. The requester's reply after their own feedback ends it, because Junior acts next. On a draft, the item says to review it, then mark it ready for review.
- `pr-mark-ready` The requester approves a draft that Junior held. Their item says to mark it ready for review.
- `conflict-ended` A Junior PR with a merge conflict item merges or closes. The item closes.
- `conflict-gone` GitHub no longer reports a merge conflict on a Junior PR. Its conflict item closes as done.
- `conflict-dismissed` The requester dismisses the merge conflict item. It stays closed until the next Resume.
- `conflict-stuck` The head commit is the same a day after Junior's conflict fix. The requester gets "Resume", and one click starts a fix.

## How to get to it (user POV)

- Ask Junior in a dashboard Conversation or in Slack.
- GitHub: comments, reviews, and checks on Junior PRs, and the Conversation link in a PR or issue body.
- Dashboard: `Settings`, `Identities`, to link a GitHub account; PR and issue cards in a Conversation.

## Driving it with browse.mjs and gh

Preconditions:

- A GitHub App installed on a scratch repo `$REPO` that nobody else uses, with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_INSTALLATION_ID` in `.env.local`, and a webhook to a public tunnel at `/api/webhooks/github`.
- The dashboard viewer has linked a GitHub account in `Settings`, `Identities`.
- Code work needs a Sandbox. Without Vercel Sandbox credentials, launch with `JUNIOR_SANDBOX_PROVIDER=docker node $S/instance.mjs launch` (no `--mock`). Inside a Vercel Sandbox, also set the extra CA that the `junior-qa` skill names. `instance.mjs doctor` passes.
- `gh` is signed in as the linked account, and is used only to read and to act as that person. `E=$RUN_DIR/evidence/github`.

- **Draft PR (`pr-draft`, `pr-assign`, `attribution`).** Run `node $S/browse.mjs --out $E/pr --timeout 600000 --goto / --fill "role=textbox[name=\"Start a conversation\"]=In $REPO, add a line 'verify-junior' to the end of README.md and open a PR." --press Enter --idle --expect 'text=/pull\/\d+/' --snap reply`. Then run `gh pr list -R $REPO --author app/<app slug> --json number,isDraft,assignees,body,url > $E/pr/prs.json`. One PR is a draft, assigned to the linked account, and its body names the requester and links the Conversation URL from `reply.url.txt`. Junior asked no question first.
- **Card (`cards`).** Run `node $S/browse.mjs --out $E/cards --goto "$(cat $E/pr/reply.url.txt)" --expect "text=$REPO" --snap card`. The PR card shows. Unlink the GitHub account and load the page again: the card does not show.
- **Feedback (`feedback-status`, `pr-follow`).** Comment `gh pr comment <n> -R $REPO -b "Please also add a trailing newline."`. Within a minute the comment has 👀. After Junior's push, it has 👍, and `gh pr view <n> -R $REPO --json commits` shows a new commit.
- **Ready (`draft-ready`).** When the checks of the draft pass, `gh pr view <n> -R $REPO --json isDraft` returns `false`.
- **Issue (`issues`).** Ask `In $REPO, open an issue titled "verify-junior issue" that says the README needs a section on setup.` Then ask `Comment on that issue: done in the PR.` `gh issue view -R $REPO "verify-junior issue" --json body,comments` shows the attribution footer and the comment.
- **Watch (`watch`).** Ask `Watch PR <n> in $REPO and tell me here when it is merged.` Merge it with `gh pr merge <n> -R $REPO --squash`. The Conversation gets a new message about the merge, and its event log has no repeated polling tool calls.
- **Default repo (`default-repo`).** Ask `Use $REPO as my default repo.`, then in the next message `How many open issues are there?`. Junior answers for `$REPO` without asking which repo.

## Gotchas

- With no Sandbox provider, every shell command fails with an OIDC credentials error, and Junior says it could not make the change. That is a missing precondition, not a GitHub failure.
- Without the GitHub App settings, Junior cannot push or open a PR. Report each sub-feature here as unreachable, with the reply that Junior gave and the setting that is missing.
- Do not give the instance a personal token, such as your own `GITHUB_TOKEN`. Junior must act as its GitHub App, and the drive proves nothing otherwise.
- Use a scratch repo. A drive opens PRs and issues, and merges one.
- `pr-follow`, `feedback-status`, `draft-ready`, and `watch` need the webhook. Check the App's recent deliveries for `200` before you blame Junior.
- `instance.mjs stop` drops the local data, not the PRs and issues. Close them on GitHub after the run, and keep `$E` as the record.
