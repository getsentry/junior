# GitHub

A user asks Junior to work in a GitHub repository: read code, change it, open and follow pull requests, and work on issues. Junior does this as its GitHub App, so the user needs no token. GitHub activity can wake a Conversation that watches it. Intent and rules: `design/github.md`.

## Sub-features

- `pr-draft` A user asks for a code change. Junior pushes a branch and opens a draft PR without asking first.
- `pr-assign` The new PR is assigned to the user's linked GitHub account.
- `attribution` The body of a PR or issue that Junior creates names the requester and links back to the Conversation.
- `pr-follow` Given a Junior PR, when a person leaves review feedback, then Junior pushes a fix and replies on GitHub, and posts nothing in the Conversation.
- `draft-ready` Given a Junior draft with no open decision, when its required checks pass, then Junior marks it ready for review.
- `draft-held` Given a Junior draft that would ask code owners to review, or whose repo `AGENTS.md` asks for drafts, when its required checks pass, then it stays a draft, and the requester gets the same one review ask as for any Junior PR: a GitHub review request and `Review requested` in the Inbox. No message explains why it is a draft. The code owners are asked only when a person marks it ready.
- `review-request` Given a Junior PR that is ready for review, then GitHub asks the reviewers that the requester named, else the requester, once, and only after the required checks pass on its head commit.
- `rereview` Given a reviewer requested changes on a Junior PR, when Junior acts after them (it pushes a fix, comments, replies to a review comment, or marks the change request addressed), then that reviewer is asked again once, after the required checks pass: on GitHub, and also in the Inbox when the reviewer is the requester. When the reviewer comments or reviews, the Inbox stops asking until Junior acts again. A reviewer who approved since is not asked.
- `push-after-approval` Given an approved Junior PR, when Junior pushes to it, then the repo's setting decides: where it dismisses stale approvals, the approver is asked for a fresh review once, after the required checks pass; where it keeps approvals, the approval stands, and `Ready to merge` follows once the required checks pass.
- `ready-to-merge` Given a Junior PR that is approved, has no open change request, passes its required checks, and has no merge conflict, then the requester gets one `Ready to merge` item, and the PR stays open until a person merges it. With auto-merge on, nobody gets the item.
- `checks-red` Given a required check fails on a Junior PR, then Junior reads its logs, finds whether the PR, the base branch, or a flake caused it, and fixes it or runs it again, without skipping, disabling, or weakening it. Only when Junior cannot resolve it and a person must act does the requester get one Review item per head commit that names the check and what Junior found.
- `conflict-fix` Given a Junior PR with a merge conflict, when the PR next needs a person, then Junior fixes the conflict first and asks nobody. The PR needs a person before Junior asks for a review or a re-review, when it is approved, and when a person pushes, reviews, or comments. A draft that Junior still works on gets the fix too.
- `conflict-idle` Given a Junior PR with a merge conflict that nobody works on, then Junior does no fix and asks nobody, for any number of days.
- `fix-unlanded` Given a Junior fix for a conflict, a check, or feedback does not land, then the requester gets one Review item that names what failed, with `Resume` and `Dismiss`. After `Dismiss`, that PR asks nobody about a fix again.
- `other-reviewers` Given a reviewer other than the requester reviews a Junior PR, then Junior acts on it and replies on GitHub, and adds no Review item for anyone.
- `no-reminders` Given an ask on a Junior PR waits, such as a review that nobody gives, then it stays one Review item, and Junior does not repeat it, reassign it, or close the PR.
- `requester-gone` Given the requester left the Conversation or has no linked GitHub account, then nobody gets a Review item for the PR.
- `long-lived` Given a Junior PR that is still open, when a person reviews, comments, or pushes weeks after it opened, then Junior does the upkeep as on the first day.
- `pr-ended` Given a Junior PR merges or closes on GitHub, by anyone, then its Review items close and Junior posts nothing.
- `stack` Given Junior opens a PR on the branch of another open PR, then the PR joins a GitHub stack, and the requester gets one `Ready to merge` item for the whole stack.
- `feedback-status` A person comments on a Junior PR. The comment gets 👀, then 👍 when Junior addresses it or 👎 when Junior declines it.
- `issues` A user asks to create, update, or comment on an issue. Junior does it, with the same attribution.
- `watch` A user asks Junior to watch a PR. Matching activity wakes the Conversation, and Junior does not poll.
- `default-repo` A user sets a default repo once. Later requests use it, and a named `owner/repo` wins.
- `cards` A Conversation that links a PR or issue shows its card only when the viewer's linked GitHub account can see the repo.

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
- **Ready (`draft-ready`, `review-request`).** While the checks of the draft run, `gh pr view <n> -R $REPO --json reviewRequests` lists nobody. When they pass, `gh pr view <n> -R $REPO --json isDraft,reviewRequests` returns `false` and the linked account once.
- **Re-review (`rereview`).** As the linked account, run `gh pr review <n> -R $REPO --request-changes -b "Use a heading, not a line."`. After Junior's push, `reviewRequests` stays empty until the required checks pass on the new head commit, then lists the linked account once.
- **Ready to merge (`ready-to-merge`).** Run `gh pr review <n> -R $REPO --approve`. When the checks pass, `node $S/browse.mjs --out $E/merge --goto /inbox --expect 'role=region[name="Needs you"] >> role=link[name=/Ready to merge · #<n>/]' --snap inbox` shows one item, and the PR is still open a minute later. Run `gh pr merge <n> -R $REPO --auto --squash` on a second approved PR: no `Ready to merge` item shows for it.
- **Red check (`checks-red`).** On a scratch repo whose required check fails on purpose on the default branch, ask for a change. Junior's reply on GitHub or its Review item names the check and says that the base branch fails it. The workflow file is unchanged, and the Inbox has at most one item for the head commit.
- **Ended (`pr-ended`).** Merge or close a PR that has an open item. The item leaves "Needs you", and the Conversation gets no new reply.
- **Other reviewer (`other-reviewers`).** As a second account, request changes. Junior pushes a fix and replies on GitHub, and the linked account's Inbox gets no new item.
- **Issue (`issues`).** Ask `In $REPO, open an issue titled "verify-junior issue" that says the README needs a section on setup.` Then ask `Comment on that issue: done in the PR.` `gh issue view -R $REPO "verify-junior issue" --json body,comments` shows the attribution footer and the comment.
- **Watch (`watch`).** Ask `Watch PR <n> in $REPO and tell me here when it is merged.` Merge it with `gh pr merge <n> -R $REPO --squash`. The Conversation gets a new message about the merge, and its event log has no repeated polling tool calls.
- **Default repo (`default-repo`).** Ask `Use $REPO as my default repo.`, then in the next message `How many open issues are there?`. Junior answers for `$REPO` without asking which repo.

## Gotchas

- With no Sandbox provider, every shell command fails with an OIDC credentials error, and Junior says it could not make the change. That is a missing precondition, not a GitHub failure.
- Without the GitHub App settings, Junior cannot push or open a PR. Report each sub-feature here as unreachable, with the reply that Junior gave and the setting that is missing.
- Do not give the instance a personal token, such as your own `GITHUB_TOKEN`. Junior must act as its GitHub App, and the drive proves nothing otherwise.
- Use a scratch repo. A drive opens PRs and issues, and merges one.
- `pr-follow`, `feedback-status`, `draft-ready`, and `watch` need the webhook. Check the App's recent deliveries for `200` before you blame Junior.
- `conflict-idle`, `no-reminders`, and `long-lived` need days of no activity. One run cannot drive them. Check them on an old scratch PR, and report the others as verified only for the paths that the run took.
- `other-reviewers` needs a second GitHub account with write access to `$REPO`.
- `instance.mjs stop` drops the local data, not the PRs and issues. Close them on GitHub after the run, and keep `$E` as the record.
