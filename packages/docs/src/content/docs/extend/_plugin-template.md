---
title: Plugin Page Template
description: Canonical structure for plugin setup pages.
type: tutorial
summary: Use this template when writing or updating plugin setup pages so readers get the same install-to-verify flow each time.
prerequisites:
  - /extend/
related:
  - /extend/
  - /reference/config-and-env/
---

Use this template for plugin setup pages so every plugin guide follows the same reader path.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-example
```

## Register the plugin

Add the package to `pluginPackages` so runtime discovery includes the plugin:

```ts title="api/index.ts"
export default handle(
  createApp({
    pluginPackages: ["@sentry/junior-example"],
  }),
);
```

## Configure environment variables

Use a table even when the answer is "none required":

| Variable        | Required | Purpose                 |
| --------------- | -------- | ----------------------- |
| `EXAMPLE_TOKEN` | Yes      | Example API credential. |

If no variables are required, replace the table with a single sentence:

`No environment variables are required for this plugin.`

## Plugin-specific setup

Explain the provider-specific setup after install and environment configuration. Keep this section concrete and action-oriented.

## Verify

Describe one real user workflow that confirms the plugin works end to end.

## Failure modes

List concrete error -> cause -> fix entries so readers can recover quickly.

## Next step

Link to the next page the reader should open after setup succeeds.
