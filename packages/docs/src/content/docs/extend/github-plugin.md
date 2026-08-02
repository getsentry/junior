---
title: GitHub Plugin
description: Configure GitHub App credentials for GitHub repository workflows.
type: tutorial
summary: Set up GitHub deployment lookup and watches alongside Junior-owned workflow dispatches, issues, pull requests, and branch pushes.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

The GitHub plugin uses one GitHub App permission envelope for the repositories Junior can reach. Junior acts as the App installation for reads, workflow dispatches, issue and pull request maintenance, and Git branch pushes. Human OAuth remains reserved for operations whose GitHub meaning is personal, such as submitting a pull request review.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-github
```

## Runtime setup

Add the GitHub plugin factory to the plugin set exported from `plugins.ts`. The factory registers the GitHub manifest,
bundled skills, and Git commit attribution hooks together.

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

Junior requests read-level installation tokens for read traffic. Allowlisted writes receive a repository-scoped token with the complete permission envelope approved on the GitHub App installation, so a branch push and the following pull request operation cannot receive mismatched permissions. Unsupported writes are still denied by the egress policy instead of borrowing a user token.

You can optionally declare `appPermissions` when registering the plugin. Junior uses that declaration to avoid an installation lookup when downscoping read tokens; it does not downscope write tokens. Keep the declaration aligned with the permissions approved in the GitHub App settings.

## Configure environment variables

Set these values in the host environment:

| Variable                   | Required | Purpose                                                                |
| -------------------------- | -------- | ---------------------------------------------------------------------- |
| `GITHUB_APP_ID`            | Yes      | GitHub App identity.                                                   |
| `GITHUB_APP_CLIENT_ID`     | Yes      | GitHub App OAuth client id for user-token auth.                        |
| `GITHUB_APP_CLIENT_SECRET` | Yes      | GitHub App OAuth client secret for user-token auth.                    |
| `GITHUB_APP_PRIVATE_KEY`   | Yes      | GitHub App signing key.                                                |
| `GITHUB_INSTALLATION_ID`   | Yes      | Repository or organization installation target.                        |
| `GITHUB_APP_BOT_NAME`      | Yes      | Git author and committer display name.                                 |
| `GITHUB_APP_BOT_EMAIL`     | Yes      | App bot noreply email used for Git attribution and work ownership.     |
| `GITHUB_WEBHOOK_SECRET`    | No       | Webhook signing secret for deployment, pull request, and issue events. |

`GITHUB_INSTALLATION_ID` selects the GitHub App installation for the deployment.
`GITHUB_APP_BOT_EMAIL` uses the GitHub noreply format
`<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`. Get the bot user id
from `https://api.github.com/users/<app-slug>%5Bbot%5D`. Junior derives the
App bot login after the `+` when classifying pull requests and issues for
outcome reporting.

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

## Run migrations

After installing or upgrading the GitHub plugin, run its packaged SQL migration
from the deployed app environment:

```bash
pnpm exec junior upgrade
```

This creates the `junior_github_pull_requests` and `junior_github_issues`
projections used by webhook ingestion and the `/system` outcome report.

## Create the GitHub App

Create and install a GitHub App before you verify GitHub workflows:

1. Open GitHub App settings and create a new app.
2. Generate a private key and store the downloaded `.pem` file securely.
3. Grant repository permissions for:
   - Actions: Read and write
   - Checks: Read
   - Deployments: Read
   - Issues: Read and write
   - Contents: Read and write
   - Pull requests: Read and write
   - Workflows: Write
   - Metadata: Read
4. If Junior should watch pull requests or report pull request and issue outcomes, enable webhooks and set the webhook URL to:

   ```text
   https://<your-domain>/api/webhooks/github
   ```

5. Set the webhook secret to the same value as `GITHUB_WEBHOOK_SECRET`, then subscribe the app to these repository events:
   - Check suite
   - Deployment
   - Deployment status
   - Issues
   - Issue comment
   - Pull request
   - Pull request review
   - Pull request review comment
6. Install the app on the repository or organization Junior should access.
7. Copy the App ID, OAuth client ID/secret, installation ID, bot name, bot noreply email, and, if you enabled webhooks, the webhook secret into your deployment environment.

Do not lower the GitHub App permission itself to read-only if Junior should create issues, push branches, or open pull requests. Junior scopes write tokens to the target repository and keeps write operations constrained by the egress allowlist.

Git smart-HTTP push classification is repository-scoped, not branch-scoped. It does not independently identify Junior-managed branches or detect force updates or ref deletion. Protect important branches in GitHub and install the App only on repositories where Junior may push.

If your team works across multiple repositories, have users include `owner/repo` in their GitHub request whenever the target is not obvious from the conversation.
That only helps when those repositories are covered by the same GitHub App installation ID.

## Watch pull request and issue events

When `GITHUB_WEBHOOK_SECRET` is configured, GitHub tools can return subscribable
pull request and issue resources. Junior can temporarily watch those resources
and send matching updates back to the current Slack thread.

Subscribed events run headlessly as Junior's `resource-event` system actor.
They can use repository-scoped installation credentials to commit and push a
follow-up fix to the watched pull request without borrowing the subscriber's
OAuth identity. Actions that represent human judgment, such as submitting a
review, still require explicit delegated user authorization.

Supported GitHub webhook deliveries become these Junior resource events:

| GitHub delivery                       | Junior event types                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `check_suite` completed               | `pull_request.checks.failed`, `pull_request.checks.recovered`                                            |
| `issue_comment` created on a PR       | `pull_request.comment.created`                                                                           |
| `pull_request_review` submitted       | `pull_request.review.approved`, `pull_request.review.changes_requested`, `pull_request.review.commented` |
| `pull_request_review_comment` created | `pull_request.review_comment.created`                                                                    |
| `pull_request` closed                 | `pull_request.merged`, `pull_request.closed_unmerged`                                                    |
| `issues` opened, closed, or reopened  | `issue.opened`, `issue.closed`, `issue.reopened`                                                         |
| `issue_comment` created on an issue   | `issue.comment.created`                                                                                  |

`pull_request.merged` and `pull_request.closed_unmerged` complete a
temporary pull request watch after Junior accepts the event. Other events keep
the watch active until it expires or is cancelled.

Webhook events are delivered as normal queued conversation messages. They do not interrupt active work, bypass Slack routing, or act as user-authored commands. Junior uses the subscription intent to decide whether to reply, take a follow-up action, or stay silent.

## Watch deployment events

Use `github_getDeployment` when Junior should inspect or watch deployments for
an exact repository and full commit SHA. Supply an environment to limit the
lookup and watch to that environment, or omit it to watch deployments for the
commit across environments. The result includes the latest matching deployment
and its latest status when GitHub has created one. It also remains subscribable
before the deployment exists, which lets Junior wait for a deployment that
will be created after a branch merge or release action.

The GitHub App needs `Deployments: read`, and its webhook must subscribe to
both Deployment and Deployment status. Junior maps those deliveries to these
resource events:

| GitHub delivery             | Junior event types                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `deployment` created        | `deployment.created`                                                                                                                 |
| `deployment_status` created | `deployment.queued`, `deployment.pending`, `deployment.in_progress`, `deployment.succeeded`, `deployment.failed`, `deployment.error` |

For an environment-specific watch, success, failure, and error complete the
subscription after Junior accepts the event. A commit-wide watch remains active
across terminal outcomes so it can observe deployments in later environments;
it ends through cancellation or its configured TTL. Creation and progress
events keep either watch active. GitHub does not send a `deployment_status`
webhook for the `inactive` state, so Junior does not offer an inactive event.

The GitHub plugin classifies a pull request or issue as Junior-owned on its
signed `opened` event when the author matches the bot login derived from
`GITHUB_APP_BOT_EMAIL` and the opening body contains Junior's session footer.
It keeps tracking that projection through later lifecycle events even if the
body changes. The `/system` dashboard charts daily pull request and issue
creation for 7-, 30-, and 90-day windows. It also reports pull request and
issue closure summaries with 30-day repository breakdowns. This reporting is
independent of conversation subscriptions and never stores pull request or
issue bodies.

When a tracked pull request merges, Junior reads its commit list with the
GitHub App installation credential. A merged pull request is `Junior-only` when
every commit's Git author matches the configured bot login or bot email. If any
commit has another author, the report classifies the pull request as `mixed`.
Older records, empty commit lists, and lookups that fail remain `unknown`; the
pull request outcome is still recorded. The repository breakdown exposes only
the count of Junior-only merges. Junior stores the full classification, not
commit SHAs, author identities, or email addresses.

The pull request projection also keeps the native Junior conversation ids from
bot-written session footers in a deduplicated `text[]`. These are opaque
association values, not foreign keys, and later bot-authored footer updates add
to the array without removing earlier ids. Junior does not store conversation
content in the GitHub projection.

If GitHub delivers a terminal event before its opening event, the plugin can
establish the same ownership from the bot-and-footer marker on that terminal
payload. This recovery applies to both pull requests and issues. A later stale
opening event cannot regress the recorded outcome.

## Verify

Run a real GitHub workflow in the chat surface where people will use it:

```text
Create a GitHub issue in owner/repo titled "Junior GitHub plugin check" with body "Verification run"
```

Then confirm:

1. The issue is created in the expected repository.
2. The author is the GitHub App bot, and the body includes `Requested by` attribution for the verified runtime actor.
3. A follow-up GitHub request can update or comment on the same issue without asking the user to authorize GitHub or handle tokens manually.
4. A pushed branch can be turned into a draft PR with `github_createPullRequest` using explicit `repo`, `head`, and `base` values.
5. After that PR merges, `/system` includes it in the repository's Junior-only merge count when every commit belongs to Junior.

For code changes, a local `git commit` does not call GitHub. The GitHub write happens when Junior pushes the branch. The App installation requires `Contents: write`; grant it `Workflows: write` when Junior may change files under `.github/workflows`. Creating the PR after the branch exists is a separate pull-request write operation, but it uses the same repository-scoped write credential.

To verify PR event watches, create a PR through Junior in Slack and ask Junior to keep an eye on CI, review changes, or merge state. Trigger one configured GitHub webhook event, then confirm GitHub reports a successful delivery to `/api/webhooks/github` and Junior handles the event in the original Slack conversation according to the watch intent.

To verify deployment watches, ask Junior to watch a known repository,
environment, and commit SHA before the deployment finishes. Confirm the
conversation has an active deployment-source subscription, then verify that a
Deployment status delivery reaches `/api/webhooks/github` and produces the
expected follow-up in the original conversation.

## Security model

- Junior mints GitHub App installation and user-to-server tokens on the host, not in the sandbox.
- When the GitHub skill runs authenticated `gh` or `git` commands, sandbox traffic to `api.github.com` and `github.com` is forwarded through Junior for host-side auth.
- App-readable requests use installation tokens downscoped to read. Allowlisted workflow dispatch, issue, pull request, and branch writes use repository-scoped installation tokens carrying the complete installed App permission envelope. GitHub account identity checks and human review operations use user-to-server tokens.
- GitHub App user-to-server tokens do not use OAuth scopes as their permission model. Their effective access comes from the App permissions, installation scope, and requesting user's access.
- The GitHub App installation determines which repositories are reachable, and repository write grants narrow issued tokens to the parsed target repository.
- The host-side lease is bounded by the sandbox session and token expiry. It is not exposed as reusable long-lived auth inside the sandbox.
- GitHub webhooks are accepted only when the `X-Hub-Signature-256` header matches `GITHUB_WEBHOOK_SECRET`.
- Resource event subscriptions are conversation-scoped. Core owns subscription records, dedupe, TTL, and mailbox delivery; the GitHub plugin owns signature verification, provider normalization, and its pull request and issue outcome projections.
- Resource-watch turns do not inherit a subscriber's user credential. Bot-owned issue, pull request, and smart-HTTP push operations use scoped installation credentials; human-owned operations still enter the normal authorization flow.
- The write boundary is the App installation scope, the single-repository token scope, and Junior's endpoint allowlist. `appPermissions` declarations do not narrow write tokens.

## Failure modes

- `Access denied` from GitHub: the app is not installed on the target repository or organization. Install the app on that target, then retry.
- `Bad credentials` or signing errors: `GITHUB_APP_PRIVATE_KEY` does not match the App ID. Upload the private key generated for the same app as `GITHUB_APP_ID`.
- PR creation works but Junior never offers to watch the PR: `GITHUB_WEBHOOK_SECRET` is missing from the deployment environment. Set it, redeploy, and create a new PR through Junior.
- `github_getDeployment` returns `403`: grant the GitHub App `Deployments: read`, approve the updated permission on its installation, and retry.
- Deployment metadata is available but Junior never offers to watch it: `GITHUB_WEBHOOK_SECRET` is missing. Set it, redeploy, and run `github_getDeployment` again.
- GitHub webhook delivery returns `401`: the webhook secret in GitHub App settings does not match `GITHUB_WEBHOOK_SECRET`, or GitHub did not send `X-Hub-Signature-256`. Update the app webhook secret and retry the delivery.
- GitHub webhook delivery returns `202 Ignored`: the delivery was signed correctly but does not map to a supported deployment, pull request, or issue event. Use one of the configured event types above.
- GitHub delivery succeeds but no Slack follow-up appears: confirm the original conversation has an active resource watch for that identifier and event type. A successful webhook alone does not create a watch.
- Missing repository context: Junior could not determine which repository to use. Include `owner/repo` directly in the GitHub request, or configure a default GitHub repository for that thread, and retry.
- A `403` response that says to use `github_createIssue` or `github_createPullRequest` is a Junior routing denial, not evidence of missing App permissions. Retry with the named tool.
- Private OAuth prompt for a human-identity operation such as a pull request review: the actor has not authorized the GitHub App yet, or the stored user-to-server token expired. Complete the private authorization prompt; do not paste personal access tokens into the chat or sandbox.
- Permission-style failures during issue or pull request workflows: the GitHub App lacks the required permission or installation scope. Update the app permissions or install target, then retry.
- Fork creation is outside the write allowlist. Routine PR creation should push a branch explicitly and use `github_createPullRequest` instead of creating a fork.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth and target-context model.
