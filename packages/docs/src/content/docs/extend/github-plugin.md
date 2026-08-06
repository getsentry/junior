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
App: issues, pull requests, reviews, branch pushes, workflow dispatches and
reruns, deployment and release lookups, and resource subscriptions.

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

### 4. Configure environment variables

| Variable                   | Required | Purpose                                                           |
| -------------------------- | -------- | ----------------------------------------------------------------- |
| `GITHUB_APP_ID`            | Yes      | GitHub App identity.                                              |
| `GITHUB_APP_CLIENT_ID`     | Yes      | OAuth client id for user-token auth.                              |
| `GITHUB_APP_CLIENT_SECRET` | Yes      | OAuth client secret for user-token auth.                          |
| `GITHUB_APP_PRIVATE_KEY`   | Yes      | GitHub App signing key.                                           |
| `GITHUB_INSTALLATION_ID`   | Yes      | Installation target.                                              |
| `GITHUB_APP_BOT_NAME`      | Yes      | Git author and committer display name.                            |
| `GITHUB_APP_BOT_EMAIL`     | Yes      | App bot noreply email for Git attribution and work ownership.     |
| `GITHUB_WEBHOOK_SECRET`    | No       | Webhook signing secret for resource events and outcome reporting. |

`GITHUB_APP_BOT_EMAIL` uses
`<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`. Get the bot user id
from `https://api.github.com/users/<app-slug>%5Bbot%5D`.

Vercel example:

```bash
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_CLIENT_ID production
vercel env add GITHUB_APP_CLIENT_SECRET production
vercel env add GITHUB_INSTALLATION_ID production
vercel env add GITHUB_APP_BOT_NAME production
vercel env add GITHUB_APP_BOT_EMAIL production
vercel env add GITHUB_APP_PRIVATE_KEY production --sensitive < ./github-app-private-key.pem
vercel env add GITHUB_WEBHOOK_SECRET production
```

### 5. Run migrations

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
- Dispatch workflows and rerun workflow runs or jobs
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

One or more checks failed.

</details>

<details class="resource-event">
<summary><code>pull_request.checks.recovered</code></summary>

Previously failing checks recovered.

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
- A `403` that names `github_createIssue` or `github_createPullRequest` is a
  Junior routing denial. Retry with the named tool.
- Private OAuth prompt for a personal operation: complete the private
  authorization prompt. Do not paste personal access tokens into chat.
- Permission failures on issue or PR workflows: update App permissions or the
  install target, then retry.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth
and target-context model.
