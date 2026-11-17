# GitHub

A user asks Junior to work in a GitHub repository: read code, change it, open and follow pull requests, review them, and work on issues. Junior does this as its GitHub App, so the user needs no token. GitHub activity can also wake a Conversation or run an Event automation. Intent and rules: `design/github.md`.

## Claims

- `pr-draft` A user asks for a code change. Junior pushes a branch and opens a draft PR without asking first, unless the user asks for a ready PR or for investigation only. Proof: none. See Gaps.
- `pr-assign` Junior opens a PR. The user sees it assigned to their linked GitHub account, and a review request to them, or to the reviewers they named, when the PR is ready. Proof: `test` with `pnpm --filter @sentry/junior-github exec vitest run tests/github-plugin.test.ts tests/pull-request-ready-reviewers.test.ts -t "assigns pull requests to the linked requester and mentions them in attribution|asks the named reviewers and keeps the requester as the assignee|to review a draft only when it becomes ready"`.
- `attribution` Junior creates a PR or an issue. Its body names the requester and links back to the Conversation. Proof: `test` with `pnpm --filter @sentry/junior-github exec vitest run tests/github-plugin.test.ts -t "creates pull requests with deterministic requester attribution|creates issues with deterministic requester attribution|adds dashboard and Sentry session links to issue footers when configured|adds a Sentry session link to pull request footers when configured"`.
- `pr-follow` Junior opened a PR. It fixes failed checks and review feedback, and replies on GitHub. It fixes merge conflicts on an active PR, and adds a Review item for the requester on an idle one. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/coding/subscriptions.eval.ts -t "when a watch asks for a fix and the PR checks fail, push the fix and end with no reply"` for failed checks, and `test` with `pnpm --filter @sentry/junior-github exec vitest run tests/merge-conflicts.test.ts -t "fixes once a day while people work on the pull request|adds one notice when nobody worked on it for 2 days"` for conflict events and the idle notice. See Gaps.
- `draft-ready` The required checks of a Junior draft pass and no decision is open. Junior marks it ready. A PR that code owners must review stays a draft, and Junior tells the requester. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/coding/subscriptions.eval.ts -t "when the checks of a Junior draft pass, mark it ready without posting|when the checks of a Junior draft with code owners pass, keep it a draft and tell the requester|when a Junior draft names an open decision, keep it a draft"`.
- `feedback-status` A person comments on a Junior PR. The comment gets 👀, then 👍 when Junior addresses it or 👎 when Junior declines it. Proof: `test` with `pnpm --filter @sentry/junior-github exec vitest run tests/webhook-outcomes.test.ts tests/update-pull-request-feedback.test.ts -t "before publishing its events|adds the addressed reaction for a fresh conversation comment|replaces Junior's prior status reaction without touching a human reaction"`. See Gaps.
- `issues` A user asks to create, update, or comment on an issue. Junior does it, with the same attribution. Proof: `test` with `pnpm --filter @sentry/junior-github exec vitest run tests/github-plugin.test.ts tests/update-issue.test.ts tests/comment-on-issue.test.ts -t "creates issues with deterministic requester attribution|updates issue metadata and preserves runtime-owned body metadata|posts an issue comment"`.
- `watch` A user asks Junior to watch a PR, issue, deployment, release, or repo. Matching activity wakes the Conversation, and Junior does not poll. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/coding/subscriptions.eval.ts -t "when a PR can emit the requested events, subscribe instead of polling|subscribes to an exact deployment before GitHub creates it|when a watched PR check fails, summarize the failure and suggest next steps"`.
- `default-repo` A user sets a default repo or org once. Later requests use it, and a named `owner/repo` always wins. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/coding/github.eval.ts -t "when a default repo is set in one turn, reuse it in the next turn without asking again|when confirming an explicit issue reference, use that issue as target"`.
- `cards` A user opens a Conversation in the dashboard. A PR or issue card shows only when the viewer's linked GitHub account can see the repo. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/objects.test.ts -t "resolves GitHub issue and pull request links for viewers who can see the repository"`.

## How to get to it

- Slack: ask Junior in a thread or DM, or use `/github-code`.
- GitHub: comments, reviews, and review comments on Junior PRs, and the Conversation link in a PR or issue.
- Dashboard: Settings, Identities, to connect GitHub; Code; PR and issue cards in Conversations.
- Runtime triggers: signed GitHub webhooks at `/api/webhooks/github`, and the daily reconcile of open PRs.

## Driving it with proofs.mjs

Preconditions:

- Compose Postgres is healthy (`docker compose up -d --wait postgres redis`). `instance.mjs launch` also starts it.
- `pnpm build` ran after the last pull, and the run directory is `$RUN_DIR`.

- **`pr-assign`, `attribution`, `pr-follow`, `feedback-status`, `issues`, `cards`: run the tests.** Run `node .agents/skills/verify-junior/scripts/proofs.mjs run --out $RUN_DIR/evidence/github .agents/skills/verify-junior/map/github.md`. Each command exits `0`. `summary.tsv` lists each command, its exit code, and the claims it proves.
- **Evals.** Add `--kind eval` to the same command. See Gotchas for what an eval run needs.

## Gotchas

- A live GitHub drive needs a GitHub App, a webhook tunnel, and a model. The plugin tests fake GitHub with MSW at its HTTP API, which is the production boundary. No drive step uses a real repo.
- Evals need `ROACH_TOKEN`, or `ROACH_MODE=off` with `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` and `cloudflared`. Without them, global setup fails before a case runs (see `SKILL.md`).

## Gaps

- `pr-draft`: no eval drives a code change to a draft PR. The closest case, `evals/coding/github.eval.ts` "when completed code work leaves an optional follow-up, open the PR without asking", asks Junior to describe what it does. It does not observe the action.
- `pr-follow`: no eval covers a fix for review feedback with a reply on GitHub, or a fix for a merge conflict on an active PR. The test proves the conflict event and the idle notice only.
- `feedback-status`: no eval proves that Junior picks addressed or declined for a comment. The tests prove the webhook reaction and the tool.
