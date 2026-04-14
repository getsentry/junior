---
title: GitHub Plugin
description: Configure GitHub App credentials for GitHub issue and pull request workflows.
type: tutorial
prerequisites:
  - /extend/
related:
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

The GitHub plugin uses a GitHub App so Junior can create and update GitHub issues and pull requests through normal GitHub requests without asking users to manage GitHub credentials directly.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-github
```

## Runtime setup

List the plugin in `juniorNitro({ pluginPackages: [...] })`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-github"],
});
```

## Configure environment variables

Set these values in the host environment:

| Variable                 | Required | Purpose                                         |
| ------------------------ | -------- | ----------------------------------------------- |
| `GITHUB_APP_ID`          | Yes      | GitHub App identity.                            |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | GitHub App signing key.                         |
| `GITHUB_INSTALLATION_ID` | Yes      | Repository or organization installation target. |

`GITHUB_INSTALLATION_ID` selects the GitHub App installation for the deployment.

Vercel example:

```bash
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_INSTALLATION_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production --sensitive < ./github-app-private-key.pem
```

## Create the GitHub App

Create and install a GitHub App before you verify GitHub workflows:

1. Open GitHub App settings and create a new app.
2. Generate a private key and store the downloaded `.pem` file securely.
3. Grant repository permissions for:
   - Issues: Read and write
   - Contents: Read and write
   - Pull requests: Read and write
   - Metadata: Read
4. Install the app on the repository or organization Junior should access.
5. Copy the App ID and installation ID into your deployment environment.

If your team works across multiple repositories, have users include `owner/repo` in their GitHub request whenever the target is not obvious from the conversation.
That only helps when those repositories are covered by the same GitHub App installation ID.

## Verify

Run a real GitHub workflow in the chat surface where people will use it:

```text
Create a GitHub issue in owner/repo titled "Junior GitHub plugin check" with body "Verification run"
```

Then confirm:

1. The issue is created in the expected repository.
2. The author is the GitHub App identity you installed.
3. A follow-up GitHub request can update or comment on the same issue without asking the user to handle tokens manually.
4. A pushed branch can be turned into a draft PR when Junior uses explicit repo targeting and `--head` during `gh pr create`.

## Security model

- Junior mints GitHub App installation tokens on the host, not in the sandbox.
- Repo-aware credential requests narrow tokens to the target repository when `owner/repo` is known.
- Capability scoping is mainly an accident-prevention layer: it keeps routine issue, contents, and pull-request workflows from minting broader write access than they need.
- It is not a full containment boundary. The agent can still request broader GitHub capabilities when a task genuinely needs them, so operators should treat GitHub App installation scope as the real trust boundary.

## Failure modes

- `Access denied` from GitHub: the app is not installed on the target repository or organization. Install the app on that target, then retry.
- `Bad credentials` or signing errors: `GITHUB_APP_PRIVATE_KEY` does not match the App ID. Upload the private key generated for the same app as `GITHUB_APP_ID`.
- Missing repository context: Junior could not determine which repository to use. Include `owner/repo` directly in the GitHub request and retry.
- Permission-style failures during issue or pull request workflows: the GitHub App lacks the required permission or installation scope. Update the app permissions or install target, then retry.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth and target-context model.
