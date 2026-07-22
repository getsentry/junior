---
title: Plugins
description: Choose, install, and register Junior plugins.
type: tutorial
summary: Add packaged or app-local integrations to a Junior app.
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/build-a-plugin/
  - /concepts/skills-and-plugins/
  - /reference/runtime-commands/
---

Plugins add provider manifests, credentials, tools, runtime hooks, background
work, and optional skills. Start with a packaged plugin when one exists; build a
custom plugin only when the app needs a new provider or deterministic runtime
behavior.

## Choose a plugin

| Plugin                                         | Use it for                                    |
| ---------------------------------------------- | --------------------------------------------- |
| [Agent Browser](/extend/agent-browser-plugin/) | Browser automation                            |
| [Amplitude](/extend/amplitude-plugin/)         | Product analytics queries                     |
| [Cloudflare](/extend/cloudflare-plugin/)       | Cloudflare resources and APIs                 |
| [Datadog](/extend/datadog-plugin/)             | Logs, metrics, and incidents                  |
| [GitHub](/extend/github-plugin/)               | Repository, issue, and pull-request workflows |
| [Hex](/extend/hex-plugin/)                     | Hex projects and runs                         |
| [Linear](/extend/linear-plugin/)               | Issues and projects                           |
| [Maintenance](/extend/maintenance-plugin/)     | Repository maintenance workflows              |
| [Memory](/extend/memory-plugin/)               | Long-term scoped memory                       |
| [Notion](/extend/notion-plugin/)               | Notion content                                |
| [Scheduler](/extend/scheduler-plugin/)         | Durable scheduled tasks                       |
| [Sentry](/extend/sentry-plugin/)               | Sentry issues and telemetry                   |
| [Vercel](/extend/vercel-plugin/)               | Vercel projects and deployments               |

## Install packaged plugins

Install only the packages the app needs:

```bash
pnpm add @sentry/junior @sentry/junior-github @sentry/junior-sentry
```

Create one plugin set for local development and production builds:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";

export const plugins = defineJuniorPlugins([
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
  "@sentry/junior-sentry",
]);
```

Point Nitro at the plugin module:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [juniorNitro({ plugins: "./plugins" })],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

Pass the same set to the app:

```ts title="server.ts"
import { createApp } from "@sentry/junior";
import { plugins } from "./plugins.ts";

export default await createApp({ plugins });
```

Manifest-only plugins may be registered by package name. Plugins with runtime
hooks export a JavaScript factory. Each provider page documents its required
registration and environment variables.

## Add an app-local plugin

App-local declarative plugins live under the app content root:

```text
app/plugins/<plugin-name>/
├── plugin.yaml
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

Use this shape for app-specific provider configuration or workflows that do not
need backend hooks. Runtime hooks and host tools require a code plugin; follow
[Build a Plugin](/extend/build-a-plugin/).

## Validate

Run validation before deploy:

```bash
pnpm exec junior check
```

If a plugin declares sandbox dependencies, also build its dependency snapshot:

```bash
pnpm exec junior snapshot create
```

## Next step

Open the provider page for credential setup, or follow
[Build a Plugin](/extend/build-a-plugin/) for a custom integration.
