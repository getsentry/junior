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
   comment, and Release.

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
- **Default:** Off. Junior only watches a new pull request when asked, or when a tool result includes a subscribable resource and the model chooses to watch it.
- **Required:** No
- **Environment override:** None

`subscribeAfterCreate` creates a temporary watch after a successful `github_createPullRequest` call. It only runs in Slack conversations that can host watches, and only when GitHub webhooks are enabled. Forced events are removed from the tool result's suggested events so the model does not re-watch them. The watch still expires normally.

This watch always includes `pull_request.review.approved` and `pull_request.merged`, even when `events` omits them. When the pull request is approved or merged, Junior mentions the people involved in the thread. These are the pull request author and assignees, the commit authors, and the people in `Co-authored-by` commit trailers. Junior only mentions people whose GitHub account or email links to a Slack user. When the reviewer or commenter links to a Slack user, Junior knows that the GitHub login and the Slack user are the same person, so it does not name them twice.

`guidance` adds short app guidance when a matching pull request event reaches the agent. It applies within the watch or event automation instruction. It cannot replace or expand that instruction, grant credentials, or bypass action review. Keep each value short.

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

## Run migrations

```bash
pnpm exec junior upgrade
```

This creates the `junior_github_pull_requests` and `junior_github_issues`
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
- Watch or automate matching events when webhooks are enabled

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

Deployment events carry `environment` and, when GitHub Actions made the
deployment for a job with `environment:`, `workflowId`, `workflowPath`, and
`workflowRunId`. Match `environment`, `workflowId`, or `workflowPath` to limit a
repository automation to one environment or one workflow. For example, an
automation on `getsentry/toolkit` for `deployment.failed` can match
`environment: "production"` and `workflowPath: ".github/workflows/deploy.yml"`.

To always watch selected events after Junior creates a pull request in this
app, set `pullRequestEvents.subscribeAfterCreate` in `plugins.ts`. To add short
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

The deployment reported an error.

</details>

#### `issue`

One issue: `owner/repo#number`.

<details class="event">
<summary><code>issue.comment.created</code></summary>

A comment was added. Trusted data includes `senderId`, the numeric GitHub user id of the commenter, and `senderLogin`. When `GITHUB_APP_BOT_EMAIL` is set, `mentionsBot` is `true` if the comment mentions the App, such as `@your-app`. Mentions in quoted lines and code do not count. GitHub sends mentions only as comment text, so `mentionsBot` shows that the comment addresses the App. It does not show who is trusted. Issue and repository watches and event automations can match these keys. To let only some people start work, match `senderId` with a list of ids. Do not match `senderLogin` for this, because a GitHub login can be renamed and then used by another account. Edited comments do not publish this event. The comment text stays untrusted content.

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

#### `pull_request`

One pull request: `owner/repo#number`.

<details class="event">
<summary><code>pull_request.checks.failed</code></summary>

A check suite finished with failure or timeout. Trusted data includes the full head SHA, suite id/url, optional `headBranch`, the PR number when one is attached, and failed check-run ids/urls when Junior can load them. Failed check names are untrusted provider content. Suites with no pull request publish only to the repository. When a watch or event automation uses `isDraft`, `authorUsername`, `authorEmail`, or `authorRole`, Junior loads those pull request fields for same-repo pull requests only. `headBranch` comes from the webhook and does not need that load.

</details>

<details class="event">
<summary><code>pull_request.checks.recovered</code></summary>

A check suite finished successfully after a failure. Trusted data includes the full head SHA, suite id/url, optional `headBranch`, and the PR number when one is attached. This is for one suite only. It does not mean the whole PR or branch is green. Suites with no pull request publish only to the repository. When a watch or event automation uses `isDraft`, `authorUsername`, `authorEmail`, or `authorRole`, Junior loads those pull request fields for same-repo pull requests only. `headBranch` comes from the webhook and does not need that load.

</details>

<details class="event">
<summary><code>pull_request.comment.created</code></summary>

A conversation comment was added.

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

A reviewer approved the pull request.

</details>

<details class="event">
<summary><code>pull_request.review.changes_requested</code></summary>

A reviewer requested changes.

</details>

<details class="event">
<summary><code>pull_request.review.commented</code></summary>

A reviewer submitted a comment-only review, or approved with a comment.

</details>

<details class="event">
<summary><code>pull_request.review_comment.created</code></summary>

An inline review comment was added.

</details>

<details class="event">
<summary><code>pull_request.merged</code></summary>

The pull request was merged.

</details>

<details class="event">
<summary><code>pull_request.closed_unmerged</code></summary>

The pull request closed without merging.

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
publish here, so you can match branch builds with `headBranch`.

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
- A `403` that names `github_createIssue`, `github_updateIssue`,
  `github_createPullRequest`, or `github_updatePullRequest` is a Junior routing
  denial. Retry with the named tool.
- Private OAuth prompt for a personal operation: complete the private
  authorization prompt. Do not paste personal access tokens into chat.
- Permission failures on issue or PR workflows: update App permissions or the
  install target, then retry.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth
and target-context model.
