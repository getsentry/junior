---
title: GitHub Plugin
description: Configure the GitHub App and use Junior for repository workflows and events.
type: tutorial
summary: Install the GitHub plugin, configure the App, then use repository workflows and watches.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/watches/
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

Use the GitHub plugin when Junior should work in repositories through a GitHub
App: issues, pull requests, reviews, branch pushes, workflow dispatches,
reruns, and cancellations, deployment and release lookups, and watches.

Junior uses the App installation for bot-owned work. Human OAuth is only for
operations that must run as the requesting user, such as user-attachment uploads.

## Setup

### 1. Install

```bash
pnpm add @sentry/junior @sentry/junior-github
```

### 2. Register the plugin

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";

export const plugins = defineJuniorPlugins([
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
]);
```

The factory registers the GitHub manifest, bundled skills, and Git commit
attribution hooks. Do not register this plugin as a bare package-name string.

Optional: declare `appPermissions` to match the App permissions approved in
GitHub. Junior uses that declaration when downscoping read tokens; it does not
narrow write tokens.

### 3. Create the GitHub App

1. Create a GitHub App and generate a private key.
2. Grant repository permissions:
   - Actions: Read and write
   - Checks: Read
   - Contents: Read and write
   - Deployments: Read
   - Issues: Read and write
   - Metadata: Read
   - Pull requests: Read and write
   - Workflows: Write

   Optional: grant the account permission Email addresses: Read. Junior then
   reads the verified emails of a connected GitHub account to link it to a
   person. Without it, Junior links the account only through the person who
   connected it.

3. Install the App on the organization or repositories Junior should reach.
4. Copy the App ID, OAuth client ID and secret, installation ID, bot name, and
   bot noreply email into your deployment environment.

If Junior should receive events or report PR/issue outcomes, also:

1. Set the webhook URL to `https://<your-domain>/api/webhooks/github`.
2. Set the webhook secret to the same value as `GITHUB_WEBHOOK_SECRET`.
3. Subscribe the App to: Check suite, Deployment, Deployment status, Issues,
   Issue comment, Pull request, Pull request review, Pull request review
   comment, Push, and Release.

Keep the App writable if Junior should create issues, push branches, or open
pull requests. Junior scopes write tokens to the target repository and still
denies unsupported writes through the egress allowlist.

Install the App only on repositories where Junior may push. Protect important
branches in GitHub. Across many repositories, users should include `owner/repo`
when the target is not obvious, and those repositories must share the same
installation ID.

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. Pass factory options to `githubPlugin({ ... })` in `plugins.ts`. Set the named deployment variables, then redeploy. Explicit repositories in requests always win over defaults.

### Conversation defaults

<details class="plugin-config">
<summary><code>github.org</code></summary>

Default GitHub organization or owner when a request does not name one.

- **Define:** `jr-rpc config set github.org <owner>`
- **Install-wide default:** `configDefaults["github.org"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>github.repo</code></summary>

Default repository in `owner/repo` form when a request does not name one.

- **Define:** `jr-rpc config set github.repo <owner/repo>`
- **Install-wide default:** `configDefaults["github.repo"]`
- **Required:** No
- **Environment override:** None

</details>

### Plugin options

<details class="plugin-config">
<summary><code>appPermissions</code></summary>

GitHub App permissions Junior may downscope to read for installation read tokens. Write tokens retain the App installation's full permission envelope.

- **Define:** `githubPlugin({ appPermissions: { contents: "write", issues: "write" } })` in `plugins.ts`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>additionalUserScopes</code></summary>

Extra OAuth scopes requested for operations that must run as the user.

- **Define:** `githubPlugin({ additionalUserScopes: ["scope"] })` in `plugins.ts`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>pullRequestEvents</code></summary>

App-configured pull request event behavior. Use this only when the app should always watch certain events after Junior creates a pull request, or should add short guidance when those events arrive.

```ts title="plugins.ts"
export const plugins = defineJuniorPlugins([
  githubPlugin({
    pullRequestEvents: {
      subscribeAfterCreate: {
        events: [
          "pull_request.checks.failed",
          "pull_request.review.changes_requested",
          "pull_request.merged",
        ],
        intent:
          "Report failed checks and requested changes. Report when the pull request merges. Stay silent otherwise.",
      },
      guidance: {
        "pull_request.checks.failed":
          "Inspect the failed checks. Fix failures caused by this change when safe.",
        "pull_request.review.changes_requested":
          "Summarize actionable feedback before deciding whether to edit code.",
      },
    },
  }),
]);
```

- **Define:** `githubPlugin({ pullRequestEvents: { ... } })` in `plugins.ts`
- **Default:** On when GitHub webhooks are enabled. After it creates a pull request, Junior watches review feedback, failed checks, and an unmerged close. It replies on GitHub to review comments and questions and pushes scoped fixes without asking first. Set `subscribeAfterCreate` to replace that Watch, or to `false` to turn it off.
- **Required:** No
- **Environment override:** None

`subscribeAfterCreate` creates a temporary watch after a successful `github_createPullRequest` call. It only runs in Slack conversations that can host watches, and only when GitHub webhooks are enabled. Forced events are removed from the tool result's suggested events so the model does not re-watch them. The watch still expires normally.

This watch always includes `pull_request.review.approved` and `pull_request.merged`, even when `events` omits them. When the pull request is approved or merged, Junior mentions the people involved in the thread. These are the pull request author and assignees, the commit authors, and the people in `Co-authored-by` commit trailers. Junior only mentions people whose GitHub account or email links to a Slack user. When the reviewer or commenter links to a Slack user, Junior knows that the GitHub login and the Slack user are the same person, so it does not name them twice.

When the base of a new pull request is the head branch of another open pull request in the same repository, `github_createPullRequest` links it into a GitHub stack. It adds the pull request to the stack of the pull request below, or creates a stack from the chain of base branches down to the trunk. A stack merges as one group, and GitHub rebases it after each merge. The pull request stays unstacked when the repository has no stacked pull requests, the pull request below is not on top of its stack, the head is the default branch, or the chain of base branches loops.

`guidance` adds short app guidance when a matching pull request event reaches the agent. It applies within the watch or event automation instruction. It cannot replace or expand that instruction, grant credentials, or bypass action review. Keep each value short.

</details>

<details class="plugin-config">
<summary><code>experimental</code></summary>

Turns on GitHub plugin behavior that is still being tested.

```ts title="plugins.ts"
export const plugins = defineJuniorPlugins([
  githubPlugin({
    experimental: { pullRequestDescriptionChecks: true },
  }),
]);
```

- **Define:** `githubPlugin({ experimental: { ... } })` in `plugins.ts`
- **Default:** Off
- **Required:** No
- **Environment override:** None

`pullRequestDescriptionChecks` checks the description before `github_createPullRequest` or `github_updatePullRequest` writes it. The decision model answers a few yes/no questions about it. The tool rejects a description that has check results, a test plan or test coverage notes, a work log, or talk about the request, or that does not say why the change is needed. The agent gets the fixes and sends the description again.

</details>

<details class="plugin-config">
<summary><code>appIdEnv</code></summary>

Names the deployment variable containing the GitHub App ID.

- **Define:** `githubPlugin({ appIdEnv: "GITHUB_APP_ID" })` in `plugins.ts`
- **Default:** `GITHUB_APP_ID`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

<details class="plugin-config">
<summary><code>clientIdEnv</code></summary>

Names the deployment variable containing the GitHub App OAuth client ID.

- **Define:** `githubPlugin({ clientIdEnv: "GITHUB_APP_CLIENT_ID" })` in `plugins.ts`
- **Default:** `GITHUB_APP_CLIENT_ID`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

<details class="plugin-config">
<summary><code>clientSecretEnv</code></summary>

Names the deployment variable containing the GitHub App OAuth client secret.

- **Define:** `githubPlugin({ clientSecretEnv: "GITHUB_APP_CLIENT_SECRET" })` in `plugins.ts`
- **Default:** `GITHUB_APP_CLIENT_SECRET`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

<details class="plugin-config">
<summary><code>privateKeyEnv</code></summary>

Names the deployment variable containing the GitHub App private key.

- **Define:** `githubPlugin({ privateKeyEnv: "GITHUB_APP_PRIVATE_KEY" })` in `plugins.ts`
- **Default:** `GITHUB_APP_PRIVATE_KEY`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

<details class="plugin-config">
<summary><code>installationIdEnv</code></summary>

Names the deployment variable containing the GitHub App installation ID.

- **Define:** `githubPlugin({ installationIdEnv: "GITHUB_INSTALLATION_ID" })` in `plugins.ts`
- **Default:** `GITHUB_INSTALLATION_ID`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

<details class="plugin-config">
<summary><code>botNameEnv</code></summary>

Names the deployment variable containing Junior's Git author and committer name.

- **Define:** `githubPlugin({ botNameEnv: "GITHUB_APP_BOT_NAME" })` in `plugins.ts`
- **Default:** `GITHUB_APP_BOT_NAME`
- **Required:** Yes
- **Environment variable:** The variable named by this option

</details>

<details class="plugin-config">
<summary><code>botEmailEnv</code></summary>

Names the deployment variable containing Junior's Git author and committer email.

- **Define:** `githubPlugin({ botEmailEnv: "GITHUB_APP_BOT_EMAIL" })` in `plugins.ts`
- **Default:** `GITHUB_APP_BOT_EMAIL`
- **Required:** Yes
- **Environment variable:** The variable named by this option

Use `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`. Get the bot user ID from `https://api.github.com/users/<app-slug>%5Bbot%5D`.

</details>

### Environment variables

<details class="plugin-config">
<summary><code>GITHUB_WEBHOOK_SECRET</code></summary>

Webhook signing secret for events and PR or issue outcome reporting.

- **Define:** Set `GITHUB_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for events and outcome reporting; otherwise no
- **Environment override:** `GITHUB_WEBHOOK_SECRET`

</details>

## Migrations

The next Vercel deploy applies this plugin's migrations, because the scaffolded
build runs [junior upgrade](/cli/upgrade/). For a local database, run
`pnpm exec junior upgrade` yourself.

The migrations create the `junior_github_pull_requests` and `junior_github_issues`
projections used by webhook ingestion and outcome tracking. Opened pull
requests also publish native code-change records for the dashboard Code page
and person profiles.

## Capabilities

Once configured, Junior can:

- Create, update, and comment on issues and pull requests
- Review pull requests and leave inline review comments as the App bot
- Push branches and open draft pull requests
- Dispatch workflows, rerun workflow runs or jobs, and cancel workflow runs
- Look up deployments and releases
- Check githubstatus.com for open or recent incidents when GitHub requests or
  checks fail
- Watch or automate matching events when webhooks are enabled
- Link issue, pull request, and commit references and URLs in Slack replies
  and in the dashboard, as GitHub does. Bare `#123` uses the one repository
  that the reply names, or else the channel's `github.repo`
- Turn `@login` into a Slack mention in Slack when the login links to a known
  person. Other logins become GitHub profile links when the text names a
  repository, or when it came from GitHub or went to GitHub
- Show a GitHub profile link in the dashboard as the person card of the known
  person who linked that login, or else as a GitHub account card
- Rewrite Slack mentions in text that tools send to GitHub. A person becomes
  their linked GitHub `@login`, or their name

Bot-owned writes use installation credentials. Personal operations still use
private user authorization when required. Merge remains outside the write
allowlist.

### Watches

Set `GITHUB_WEBHOOK_SECRET` to enable events. See
[Watches](/concepts/watches/) for temporary watches versus durable event
automations.

Issue and pull request events can target one item with `owner/repo#number`, or
every item of that kind in a repository with `owner/repo`. Deployment events can
target one commit with `deployment_source`, or every deployment in a repository
with `owner/repo`.

Deployment events carry `repo`, `commit_sha`, `deployment_id`, `environment`,
and, when GitHub Actions made the deployment for a job with `environment:`,
`workflow_id`, `workflow_path`, and `workflow_run_id`. Match `environment`, `workflow_id`, or `workflow_path` to limit a
repository automation to one environment or one workflow. For example, an
automation on `getsentry/toolkit` for `deployment.failed` can match
`environment: "production"` and `workflow_path: ".github/workflows/deploy.yml"`.

An event automation selects one item with filters instead: `repo` and
`issue` or `pull_request`, `repo` and `tag`, or `repo`, `commit_sha`, and
`environment`. Lookup tools return these filters as `match`. With fewer filters,
it runs for more items. Deployment events (`deployment.created`, `deployment.queued`,
`deployment.pending`, `deployment.in_progress`, `deployment.succeeded`,
`deployment.failed`, `deployment.error`) can run that way with no filter.
Release, issue, and pull request events need a `repo` filter, because they
carry text from repositories that can be private. Junior saves `repo` in
lowercase. The filter does not check that the creator can see the repository,
so a broad deployment automation can post private repository names in its
channel. See [Automations](/concepts/automations/).

Junior watches each pull request that it creates. To change the events or
the instruction of that watch, set `pullRequestEvents.subscribeAfterCreate` in
`plugins.ts`, or set it to `false` to turn it off. That watch
also always gets `pull_request.review.approved`, `pull_request.merged`, and
`pull_request.merge_conflict`. To add short
app guidance for one pull request event type, set
`pullRequestEvents.guidance`. The guidance applies within each watch or event
automation instruction. It does not replace or expand that instruction.

#### `deployment_source`

One commit, optionally limited to an environment. Identifier:
`deployment-source:owner/repo[:environment]:<full-commit-sha>`.

<details class="event">
<summary><code>deployment.created</code></summary>

A deployment was created.

</details>

<details class="event">
<summary><code>deployment.queued</code></summary>

The deployment entered the queue.

</details>

<details class="event">
<summary><code>deployment.pending</code></summary>

The deployment is waiting to start.

</details>

<details class="event">
<summary><code>deployment.in_progress</code></summary>

The deployment started.

</details>

<details class="event">
<summary><code>deployment.succeeded</code></summary>

The deployment completed successfully.

</details>

<details class="event">
<summary><code>deployment.failed</code></summary>

The deployment failed.

</details>

<details class="event">
<summary><code>deployment.error</code></summary>

The deploy tool set the GitHub status to `error`. For a deployment that ran
and failed, use `deployment.failed`. Vercel `deployment.error` is the same as
GitHub `deployment.failed`.

</details>

#### `issue`

One issue: `owner/repo#number`. Every issue event has `repo` and `issue` in
trusted data.

<details class="event">
<summary><code>issue.comment.created</code></summary>

A comment was added. Trusted data includes `senderId`, the numeric GitHub user id of the commenter, and `senderLogin`. When `GITHUB_APP_BOT_EMAIL` is set, `mentionsBot` is `true` if the comment mentions the App, such as `@your-app`. Mentions in quoted lines and code do not count. GitHub sends mentions only as comment text, so `mentionsBot` shows that the comment addresses the App. It does not show who is trusted. Issue, pull request, and repository watches and event automations can match these keys. To let only some people start work, match `senderId` with a list of ids. Do not match `senderLogin` for this, because a GitHub login can be renamed and then used by another account. Edited comments do not publish this event. The comment text stays untrusted content.

</details>

<details class="event">
<summary><code>issue.opened</code></summary>

The issue was opened.

</details>

<details class="event">
<summary><code>issue.closed</code></summary>

The issue was closed.

</details>

<details class="event">
<summary><code>issue.reopened</code></summary>

The issue was reopened.

</details>

<details class="event">
<summary><code>issue.updated</code></summary>

The title or body was edited, or a label, assignee, or milestone was added or removed. The trusted summary names the change and who made it. Trusted data includes `change`, the webhook action such as `labeled`, and `senderId` and `senderLogin` for who made it. On `labeled` and `unlabeled`, trusted data also includes `label`, the lowercase label name. Event automations can match these keys. To run on one label that only some people add, match `change`, `label`, and `senderId`. Milestone names stay untrusted content. Updates that the App makes do not publish this event. Issue watches suggest this event. Repository watches support it but do not suggest it, because updates are frequent across a repository.

</details>

#### `pull_request`

One pull request: `owner/repo#number`. Every pull request event has `repo` and
`pull_request` in trusted data.

<details class="event">
<summary><code>pull_request.checks.failed</code></summary>

A check suite finished with failure or timeout. Trusted data includes the full head SHA, suite id/url, optional `head_branch`, the PR number when one is attached, and failed check-run ids/urls when Junior can load them. Failed check names are untrusted provider content. Suites with no pull request publish only to the repository. When a watch or event automation uses `is_draft`, `opener_username`, `opener_email`, or `opener_role`, Junior loads those pull request fields for same-repo pull requests only. `authors` loads from the pull request commits. `head_branch` comes from the webhook and does not need that load.

</details>

<details class="event">
<summary><code>pull_request.checks.recovered</code></summary>

A check suite finished successfully. Trusted data includes the full head SHA, suite id/url, optional `head_branch`, and the PR number when one is attached. This is for one suite only. It does not mean the whole PR or branch is green. Use `pull_request.checks.passed` for that. Suites with no pull request publish only to the repository. When a watch or event automation uses `is_draft`, `opener_username`, `opener_email`, or `opener_role`, Junior loads those pull request fields for same-repo pull requests only. `authors` loads from the pull request commits. `head_branch` comes from the webhook and does not need that load.

</details>

<details class="event">
<summary><code>pull_request.checks.passed</code></summary>

Every check suite on the head commit passed. A suite passes when it finishes with success, neutral, or skipped, and the suite that finishes last can have any of these results. A queued suite with no check runs does not count, because GitHub makes one for each app that can write checks, even when the app adds no check run. GitHub Actions suites always count. Commit statuses do not count. A Watch or event automation gets this event once for each head commit, even when two suites finish at the same time. Trusted data is the same as `pull_request.checks.recovered`, for the suite that finished last. Junior reads the other suites of the commit only when a Watch or event automation wants this event, with one GitHub API read for each 100 suites.

</details>

<details class="event">
<summary><code>pull_request.comment.created</code></summary>

A conversation comment was added. Trusted data includes `senderId`, `senderLogin`, and `mentionsBot` for who wrote it, the same as `issue.comment.created`.

</details>

<details class="event">
<summary><code>pull_request.opened</code></summary>

The pull request was opened.

</details>

<details class="event">
<summary><code>pull_request.ready_for_review</code></summary>

The pull request became ready for review.

</details>

<details class="event">
<summary><code>pull_request.review.approved</code></summary>

A reviewer approved the pull request. Trusted data includes `senderId`, `senderLogin`, and `mentionsBot` for who wrote it, the same as `issue.comment.created`.

</details>

<details class="event">
<summary><code>pull_request.review.changes_requested</code></summary>

A reviewer requested changes. Trusted data includes `senderId`, `senderLogin`, and `mentionsBot` for who wrote it, the same as `issue.comment.created`.

</details>

<details class="event">
<summary><code>pull_request.review.commented</code></summary>

A reviewer submitted a comment-only review, or approved with a comment. Trusted data includes `senderId`, `senderLogin`, and `mentionsBot` for who wrote it, the same as `issue.comment.created`.

</details>

<details class="event">
<summary><code>pull_request.review_comment.created</code></summary>

An inline review comment was added. Trusted data includes `senderId`, `senderLogin`, and `mentionsBot` for who wrote it, the same as `issue.comment.created`.

</details>

<details class="event">
<summary><code>pull_request.merged</code></summary>

The pull request was merged. For a pull request that Junior opened, when
GitHub does not send this webhook, Junior finds the merge within about two
days and sends this event then. A Watch gets each merge once.

</details>

<details class="event">
<summary><code>pull_request.closed_unmerged</code></summary>

The pull request closed without merging. Junior finds a missed close the
same way as a missed merge.

</details>

<details class="event">
<summary><code>pull_request.merge_conflict</code></summary>

The pull request has merge conflicts with its base branch. GitHub sends no
webhook for this. When a webhook delivers another event for an open pull
request, such as a comment, a review, or a check result, and a watch or event
automation wants this event, Junior checks its mergeability. A `pull_request`
webhook includes mergeability, so Junior uses it when GitHub knows it. Review,
comment, and check webhooks do not include it, so Junior reads the pull
request. If GitHub reports a conflict, Junior publishes this event. Each head commit publishes once. GitHub
calculates mergeability only when someone reads the pull request, so the first
read can be unknown, and a later event reads it again. A push to the default
branch of a repository with open pull requests that Junior opened also starts a
check. The push webhook only saves the check. About two minutes later, the
heartbeat finds those pull requests with one GraphQL search, which includes
their mergeability, so many pushes in a short time give one search. When an answer is
unknown, the heartbeat searches again one minute later. A pull request that Junior
did not open and that gets no other events is not checked. Trusted data includes `base_branch`, `head_sha`,
and `url`. Filters can match only `repo` and `pull_request`. The watch that
Junior creates after it opens a pull request always gets this event, and the
default guidance tells the agent to merge the base branch, not rebase. For a
pull request in a stack, the guidance tells the agent to restack with
`gh stack rebase`, because a stack merges only with a linear history.

</details>

#### `release_source`

One repository, optionally limited to a tag. Identifier:
`release-source:owner/repo[:tag]`.

<details class="event">
<summary><code>release.published</code></summary>

A release was published.

</details>

#### `repository`

Every deployment, issue, and pull request in `owner/repo`. Supports the same
`deployment`, `issue`, and `pull_request` events listed above. Check suites with no pull request also
publish here, so you can match branch builds with `head_branch`.

## Verify

```text
Create a GitHub issue in owner/repo titled "Junior GitHub plugin check" with body "Verification run"
```

Confirm:

1. The issue lands in the expected repository.
2. The author is the App bot, and the body includes `Requested by` attribution.
3. A follow-up can update or comment on the same issue without manual tokens.
4. A pushed branch can become a draft PR with `github_createPullRequest`.
5. If webhooks are enabled, ask Junior to watch a PR or deployment and confirm a
   matching GitHub delivery to `/api/webhooks/github` produces the expected
   Slack follow-up.

A local `git commit` does not call GitHub. The write happens on push. Grant
`Workflows: write` when Junior may change files under `.github/workflows`.

## Failure modes

- `Access denied`: install the App on the target repository or organization.
- `Bad credentials` or signing errors: `GITHUB_APP_PRIVATE_KEY` does not match
  `GITHUB_APP_ID`.
- Junior never offers to watch a PR, release, or deployment:
  `GITHUB_WEBHOOK_SECRET` is missing, or the App webhook is not subscribed to
  the needed event. Set the secret, fix the subscription, redeploy, and retry.
- `github_getDeployment` returns `403`: grant `Deployments: read`, approve the
  permission on the installation, and retry.
- Webhook delivery returns `401`: the App webhook secret does not match
  `GITHUB_WEBHOOK_SECRET`, or `X-Hub-Signature-256` is missing.
- Webhook delivery returns `202 Ignored`: wrong installation, or an unsupported
  event mapping. Confirm `GITHUB_INSTALLATION_ID` and the event type.
- Delivery succeeds but nothing appears in Slack: create a watch
  or event automation first. A webhook alone does not create either one.
- Missing repository context: include `owner/repo`, or set a thread default
  repository.
- A `403` that names `github_createIssue`, `github_getIssue`,
  `github_updateIssue`, `github_createPullRequest`, or
  `github_updatePullRequest` is a Junior routing denial. Retry with the named
  tool.
- Private OAuth prompt for a personal operation: complete the private
  authorization prompt. Do not paste personal access tokens into chat.
- Permission failures on issue or PR workflows: update App permissions or the
  install target, then retry.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth
and target-context model.
