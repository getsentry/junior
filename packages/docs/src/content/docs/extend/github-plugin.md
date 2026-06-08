---
title: GitHub Plugin
description: Configure GitHub App credentials for GitHub issue and pull request workflows.
type: tutorial
summary: Set up GitHub App installation reads and requester-attributed GitHub writes.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

The GitHub plugin uses one GitHub App permission envelope for the repositories Junior can reach. Junior reads through downscoped installation tokens and performs writes through GitHub App user-to-server tokens attributed to the requesting GitHub user with the app badge.

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
    appPermissions: {
      actions: "write",
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
      workflows: "write",
    },
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
]);
```

`appPermissions` should match the permissions configured on the GitHub App. These values do not make installation-token reads write-capable: Junior requests read-level installation tokens for `installation-read` traffic and omits permissions that GitHub does not expose at `read`. Writes still require the requester, or an explicitly delegated user subject, to complete the private GitHub App OAuth flow.

## Configure environment variables

Set these values in the host environment:

| Variable                   | Required | Purpose                                             |
| -------------------------- | -------- | --------------------------------------------------- |
| `GITHUB_APP_ID`            | Yes      | GitHub App identity.                                |
| `GITHUB_APP_CLIENT_ID`     | Yes      | GitHub App OAuth client id for user-token auth.     |
| `GITHUB_APP_CLIENT_SECRET` | Yes      | GitHub App OAuth client secret for user-token auth. |
| `GITHUB_APP_PRIVATE_KEY`   | Yes      | GitHub App signing key.                             |
| `GITHUB_INSTALLATION_ID`   | Yes      | Repository or organization installation target.     |
| `GITHUB_APP_BOT_NAME`      | Yes      | Git author name, for example `<app-slug>[bot]`.     |
| `GITHUB_APP_BOT_EMAIL`     | Yes      | Git author noreply email for the App bot user.      |

`GITHUB_INSTALLATION_ID` selects the GitHub App installation for the deployment.
`GITHUB_APP_BOT_EMAIL` uses the GitHub noreply format
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
```

## Create the GitHub App

Create and install a GitHub App before you verify GitHub workflows:

1. Open GitHub App settings and create a new app.
2. Generate a private key and store the downloaded `.pem` file securely.
3. Grant repository permissions for:
   - Actions: Read and write
   - Issues: Read and write
   - Contents: Read and write
   - Pull requests: Read and write
   - Workflows: Write
   - Metadata: Read
4. Install the app on the repository or organization Junior should access.
5. Copy the App ID, OAuth client ID/secret, installation ID, bot name, and bot noreply email into your deployment environment.

Do not lower the GitHub App permission itself to read-only if Junior should create issues, push branches, or open pull requests. GitHub App user-to-server tokens are still constrained by the app's installed permissions, the installation's repository access, and the requesting user's own GitHub access. Junior's read-only default applies to installation-token leases, not to the App permission envelope.

If your team works across multiple repositories, have users include `owner/repo` in their GitHub request whenever the target is not obvious from the conversation.
That only helps when those repositories are covered by the same GitHub App installation ID.

## Verify

Run a real GitHub workflow in the chat surface where people will use it:

```text
Create a GitHub issue in owner/repo titled "Junior GitHub plugin check" with body "Verification run"
```

Then confirm:

1. The issue is created in the expected repository.
2. The author is the requesting GitHub user with the GitHub App badge.
3. A follow-up GitHub request can update or comment on the same issue without asking the user to handle tokens manually after authorization.
4. A pushed branch can be turned into a draft PR when Junior uses explicit repo targeting and `--head` during `gh pr create`.

For code changes, a local `git commit` does not call GitHub. The GitHub write happens when Junior pushes the branch or writes Git objects through the REST API. Those operations require `Contents: write` on the target repository and write access for the requesting GitHub user. If the commit changes workflow files under `.github/workflows`, expect `Workflows: write` as well. Creating the PR after the branch exists is a separate pull-request write operation.

## Security model

- Junior mints GitHub App installation and user-to-server tokens on the host, not in the sandbox.
- When the GitHub skill runs authenticated `gh` or `git` commands, sandbox traffic to `api.github.com` and `github.com` is forwarded through Junior for host-side auth.
- App-readable requests use GitHub App installation tokens that Junior downscopes to read. GitHub account identity checks and write requests require the requester to authorize the GitHub App, then use that user's GitHub App user-to-server token.
- GitHub App user-to-server tokens do not use OAuth scopes as their permission model. Effective write access comes from the GitHub App permissions, the app installation's repository access, and the requesting user's own GitHub access.
- The GitHub App installation determines which repositories are reachable. Repo context guides command flags; it does not narrow issued credentials.
- The host-side lease is bounded by the sandbox session and token expiry. It is not exposed as reusable long-lived auth inside the sandbox.
- Capability scoping is mainly an accident-prevention layer: it keeps routine issue, contents, and pull-request workflows from minting broader write access than they need.
- It is not a full containment boundary. The agent can still request broader GitHub capabilities when a task genuinely needs them, so operators should treat GitHub App installation scope as the real trust boundary.

## Failure modes

- `Access denied` from GitHub: the app is not installed on the target repository or organization. Install the app on that target, then retry.
- `Bad credentials` or signing errors: `GITHUB_APP_PRIVATE_KEY` does not match the App ID. Upload the private key generated for the same app as `GITHUB_APP_ID`.
- Missing repository context: Junior could not determine which repository to use. Include `owner/repo` directly in the GitHub request, or configure a default GitHub repository for that thread, and retry.
- Private OAuth prompt for GitHub writes: the requester has not authorized the GitHub App yet, or the stored user-to-server token expired. Complete the private authorization prompt; do not paste personal access tokens into the chat or sandbox.
- Permission-style failures during issue or pull request workflows: the GitHub App lacks the required permission or installation scope. Update the app permissions or install target, then retry.
- Fork creation failures: GitHub requires `Administration: write` and `Contents: read`, plus app installation on both source and destination accounts. Routine PR creation should push a branch explicitly and use `gh pr create --head` instead of creating a fork.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth and target-context model.
