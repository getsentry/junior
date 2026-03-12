---
title: GitHub Plugin
description: Configure GitHub App credentials for issue workflows.
type: tutorial
summary: Install the GitHub plugin, register it with withJunior, configure GitHub App credentials, and verify issue workflows.
prerequisites:
  - /extend/
related:
  - /reference/config-and-env/
  - /reference/runtime-commands/
---

The GitHub plugin uses a GitHub App so Junior can create and update issues with explicit capability scoping.

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

Create and install a GitHub App before you issue credentials at runtime:

1. Open GitHub App settings and create a new app.
2. Generate a private key and store the downloaded `.pem` file securely.
3. Install the app on the repository or organization Junior should access.
4. Copy the App ID and installation ID into your deployment environment.

If you want a stable default repository for issue creation, set it once:

```bash
jr-rpc config set github.repo getsentry/junior
```

## Verify

Issue a capability-scoped credential and create a test issue:

```bash
jr-rpc issue-credential github.issues.write
gh issue create --repo owner/repo --title "Example issue" --body "Created from Junior"
```

Confirm the issue is created successfully and attributed to the GitHub App identity.

## Failure modes

- `Access denied` from GitHub: the app is not installed on the target repository or organization. Install the app on that target, then retry.
- `Bad credentials` or signing errors: `GITHUB_APP_PRIVATE_KEY` does not match the App ID. Upload the private key generated for the same app as `GITHUB_APP_ID`.
- Missing repository context: no repo was provided for the action. Pass `--repo owner/repo` or set `github.repo` with `jr-rpc config set`.
- Missing capability: the issued credential scope does not cover the requested operation. Re-issue credentials with the required GitHub capability.

## Next step

Read [Runtime Commands](/reference/runtime-commands/) for credential and config command behavior.
