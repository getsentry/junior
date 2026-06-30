---
title: Maintenance Plugin
description: Keep a Junior app's Junior dependencies and config up to date.
type: tutorial
summary: Enable Junior's self-update workflow for app maintainers.
prerequisites:
  - /start-here/quickstart/
related:
  - /cli/init/
  - /extend/
  - /extend/github-plugin/
  - /cli/check/
---

The maintenance plugin ships app-maintainer workflows for keeping a Junior app current. Apps created with `junior init` include it by default.

The plugin itself requires no credentials, OAuth, or provider configuration. Its skills use the app's existing package manager and repository tooling.

## Install

If your app was created with a recent `junior init`, `@sentry/junior-maintenance` is already installed and registered.

For an existing app:

```bash
pnpm add @sentry/junior-maintenance
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins([
  "@sentry/junior-maintenance",
]);
```

Point `juniorNitro()` at that module in `nitro.config.ts`:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

## Configure environment variables

No environment variables are required by the maintenance plugin.

The `self-update` skill uses the app's existing package manager and repository tooling. If you want the skill to open or update pull requests automatically, the sandbox environment also needs a working GitHub CLI or GitHub plugin credentials.

## Skills

| Skill | Purpose |
| ----- | ------- |
| `self-update` | Updates `@sentry/junior` and enabled `@sentry/junior-*` packages to the latest published release, syncs the lockfile, runs checks and builds, and opens a draft pull request. |

The `self-update` skill also builds a best-effort release summary from npm publish timestamps and merged PRs, and compares app config against Junior's example app to catch config-shape drift before checks run.

The detailed step-by-step workflow lives in the skill itself.

## Verify

In Slack, ask Junior to update its Junior dependencies:

```text
update this Junior app to the latest Junior packages
```

Confirm that Junior reports the current and target versions, bumps package files on a branch, runs checks, and opens or prepares a draft pull request.

## Failure modes

- **Skill not available**: confirm `@sentry/junior-maintenance` is installed, listed in `plugins.ts`, and `juniorNitro({ plugins: "./plugins" })` is configured in `nitro.config.ts`.
- **Version mismatch warning**: keep `@sentry/junior` and `@sentry/junior-*` packages pinned to the same exact version. The skill will flag inconsistencies.
- **PR creation fails**: confirm repository remotes and GitHub CLI auth are available in the sandbox, or finish the update manually from the prepared branch.
- **Checks fail after update**: the skill will surface breaking or config-relevant Junior PRs in the draft PR body. Review those items and compare your config with Junior's example app.

## Next step

Read [Plugins](/extend/) for the full plugin system, or [junior init](/cli/init/) for the generated app shape.
