---
title: GitHub Plugin
description: Configure the GitHub App and use Junior for repository workflows and resource events.
type: tutorial
summary: Install the GitHub plugin, configure the App, then use repository workflows and resource subscriptions.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /concepts/resource-subscriptions/
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

Use the GitHub plugin when Junior should work in repositories through a GitHub
App: issues, pull requests, reviews, branch pushes, workflow dispatches,
reruns, and cancellations, deployment and release lookups, and resource subscriptions.

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
3. Install the App on the organization or repositories Junior should reach.
4. Copy the App ID, OAuth client ID and secret, installation ID, bot name, and
   bot noreply email into your deployment environment.

If Junior should receive resource events or report PR/issue outcomes, also:

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

Install-local pull request event behavior. Use this only when one install should always watch certain events after Junior creates a pull request, or should add short guidance when those events arrive.

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

`subscribeAfterCreate` creates a temporary resource subscription after a successful `github_createPullRequest` call. It only runs in Slack conversations that can host resource subscriptions, and only when GitHub webhooks are enabled. Forced events are removed from the tool result's suggested events so the model does not re-watch them. The subscription still expires like any other watch.

`guidance` adds short install text when a matching pull request event reaches the agent. Keep each value short. Guidance cannot grant credentials or bypass action review.

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

Webhook signing secret for resource events and PR or issue outcome reporting.

- **Define:** Set `GITHUB_WEBHOOK_SECRET` in the deployment environment
- **Required:** Yes for resource events and outcome reporting; otherwise no
- **Environment override:** `GITHUB_WEBHOOK_SECRET`

</details>

## Run migrations

```bash
pnpm exec junior upgrade
```

This creates the `junior_github_pull_requests` and `junior_github_issues`
projections used by webhook ingestion and the `/system` outcome report.

## Capabilities

Once configured, Junior can:

- Create, update, and comment on issues and pull requests
- Review pull requests and leave inline review comments as the App bot
- Push branches and open draft pull requests
- Dispatch workflows, rerun workflow runs or jobs, and cancel workflow runs
- Look up deployments and releases
- Watch or automate matching resource events when webhooks are enabled

Bot-owned writes use installation credentials. Personal operations still use
private user authorization when required. Merge remains outside the write
allowlist.

### Resource subscriptions

Set `GITHUB_WEBHOOK_SECRET` to enable resource events. See
[Resource Subscriptions](/concepts/resource-subscriptions/) for temporary
resource subscriptions versus durable event tasks.

Issue and pull request events can target one item with `owner/repo#number`, or
every item of that kind in a repository with `owner/repo`.

To always watch selected events after Junior creates a pull request in this
install, set `pullRequestEvents.subscribeAfterCreate` in `plugins.ts`. To add
short install guidance when those events arrive, set
`pullRequestEvents.guidance`.

#### `deployment_source`

One commit, optionally limited to an environment. Identifier:
`deployment-source:owner/repo[:environment]:<full-commit-sha>`.

<details class="resource-event">
<summary><code>deployment.created</code></summary>

A deployment was created.

</details>

<details class="resource-event">
<summary><code>deployment.queued</code></summary>

The deployment entered the queue.

</details>

<details class="resource-event">
<summary><code>deployment.pending</code></summary>

The deployment is waiting to start.

</details>

<details class="resource-event">
<summary><code>deployment.in_progress</code></summary>

The deployment started.

</details>

<details class="resource-event">
<summary><code>deployment.succeeded</code></summary>

The deployment completed successfully.

</details>

<details class="resource-event">
<summary><code>deployment.failed</code></summary>

The deployment failed.

</details>

<details class="resource-event">
<summary><code>deployment.error</code></summary>

The deployment reported an error.

</details>

#### `issue`

One issue: `owner/repo#number`.

<details class="resource-event">
<summary><code>issue.comment.created</code></summary>

A comment was added.

</details>

<details class="resource-event">
<summary><code>issue.opened</code></summary>

The issue was opened.

</details>

<details class="resource-event">
<summary><code>issue.closed</code></summary>

The issue was closed.

</details>

<details class="resource-event">
<summary><code>issue.reopened</code></summary>

The issue was reopened.

</details>

#### `pull_request`

One pull request: `owner/repo#number`.

<details class="resource-event">
<summary><code>pull_request.checks.failed</code></summary>

A check suite finished with failure or timeout. Trusted data includes the PR, full head SHA, suite id/url, and failed check-run ids/urls when enrichment works. Failed check names are untrusted provider content.

</details>

<details class="resource-event">
<summary><code>pull_request.checks.recovered</code></summary>

A check suite finished successfully after a failure. Trusted data includes the PR, full head SHA, and suite id/url. This is for one suite only. It does not mean the whole PR is green.

</details>

<details class="resource-event">
<summary><code>pull_request.comment.created</code></summary>

A conversation comment was added.

</details>

<details class="resource-event">
<summary><code>pull_request.opened</code></summary>

The pull request was opened.

</details>

<details class="resource-event">
<summary><code>pull_request.ready_for_review</code></summary>

The pull request became ready for review.

</details>

<details class="resource-event">
<summary><code>pull_request.review.approved</code></summary>

A reviewer approved the pull request.

</details>

<details class="resource-event">
<summary><code>pull_request.review.changes_requested</code></summary>

A reviewer requested changes.

</details>

<details class="resource-event">
<summary><code>pull_request.review.commented</code></summary>

A reviewer submitted a comment-only review.

</details>

<details class="resource-event">
<summary><code>pull_request.review_comment.created</code></summary>

An inline review comment was added.

</details>

<details class="resource-event">
<summary><code>pull_request.merged</code></summary>

The pull request was merged.

</details>

<details class="resource-event">
<summary><code>pull_request.closed_unmerged</code></summary>

The pull request closed without merging.

</details>

#### `release_source`

One repository, optionally limited to a tag. Identifier:
`release-source:owner/repo[:tag]`.

<details class="resource-event">
<summary><code>release.published</code></summary>

A release was published.

</details>

#### `repository`

Every issue and pull request in `owner/repo`. Supports the same `issue` and
`pull_request` events listed above.

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
- Delivery succeeds but nothing appears in Slack: create a resource subscription
  or event task first. A webhook alone does not create either one.
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
