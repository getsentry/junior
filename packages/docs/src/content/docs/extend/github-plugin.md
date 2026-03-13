---
title: GitHub Plugin
description: Configure GitHub App credentials for issue workflows.
type: tutorial
summary: Install the GitHub plugin, register it with withJunior, configure GitHub App access, and verify GitHub issue workflows.
prerequisites:
  - /extend/
related:
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

The GitHub plugin uses a GitHub App so Junior can create and update issues through normal GitHub requests without asking users to manage GitHub credentials directly.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-github
```

## Register with `withJunior`

Add the package to `pluginPackages` so build-time tracing and runtime discovery use the same explicit plugin list:

```ts title="next.config.mjs"
import { withJunior } from "@sentry/junior/config";

export default withJunior({
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
3. Install the app on the repository or organization Junior should access.
4. Copy the App ID and installation ID into your deployment environment.

If your team works across multiple repositories, have users include `owner/repo` in their GitHub request whenever the target is not obvious from the conversation.

## Verify

Run a real GitHub workflow in the chat surface where people will use it:

```text
Create a GitHub issue in owner/repo titled "Junior GitHub plugin check" with body "Verification run"
```

Then confirm:

1. The issue is created in the expected repository.
2. The author is the GitHub App identity you installed.
3. A follow-up GitHub request can update or comment on the same issue without asking the user to handle tokens manually.

## Failure modes

- `Access denied` from GitHub: the app is not installed on the target repository or organization. Install the app on that target, then retry.
- `Bad credentials` or signing errors: `GITHUB_APP_PRIVATE_KEY` does not match the App ID. Upload the private key generated for the same app as `GITHUB_APP_ID`.
- Missing repository context: Junior could not determine which repository to use. Include `owner/repo` directly in the GitHub request and retry.
- Permission-style failures during issue creation or updates: the GitHub App lacks the required permission or installation scope. Update the app permissions or install target, then retry.

## Next step

Read [Plugin Auth & Context](/reference/runtime-commands/) for the public auth and target-context model.
