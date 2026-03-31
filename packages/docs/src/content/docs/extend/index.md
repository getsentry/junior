---
title: Plugins
description: Where Junior plugins live, how to add them, and how to build your own.
type: tutorial
summary: Use local or packaged plugins, register them correctly, and build your own plugin manifest and skills.
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/github-plugin/
  - /extend/notion-plugin/
  - /extend/sentry-plugin/
---

Junior plugins are just manifests plus skills. Keep the runtime wiring stable, then add behavior by putting plugins in the right place and registering packaged ones explicitly.

## Where plugins live

A plugin bundles:

- A manifest (`plugin.yaml`) that declares optional capabilities, optional config keys, and optional credential behavior.
- Skills (`SKILL.md`) that consume those capabilities at runtime.

For app-specific workflows, define plugins directly in your app:

```text
app/plugins/<plugin-name>/
├── plugin.yaml
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

Use this when you want fast iteration inside a single app without publishing packages.

For shared integrations, publish the same shape as an npm package:

```text
my-junior-plugin/
├── package.json
├── plugin.yaml
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

## How to add packaged plugins

For reuse across apps or teams, package plugin manifests + skills as npm packages and install them next to `@sentry/junior`.

```bash
pnpm add @sentry/junior @sentry/junior-github @sentry/junior-notion @sentry/junior-sentry
```

Then register those package names in `createApp(...)` so runtime discovery uses the same explicit package list:

```ts title="api/index.ts"
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";
import { handle } from "hono/vercel";

export default handle(
  createApp({
    pluginPackages: [
      "@sentry/junior-github",
      "@sentry/junior-notion",
      "@sentry/junior-sentry",
    ],
  }),
);
```

If you publish your own package, include `plugin.yaml` and `skills` in package `files` so runtime discovery works.

## Local skills vs plugin skills

Junior discovers both:

- App-local skills in `app/skills/<skill-name>/SKILL.md`
- Plugin-provided skills under each plugin’s `skills/` root

Use `app/skills` for skills that do not belong to a plugin. Use plugin skills when the skill depends on provider-specific capabilities or config.

## Build your own plugin

Most custom plugins need a `plugin.yaml` and at least one skill.

### Minimal manifest

```yaml
name: my-provider
description: Internal workflow bundles
```

### Provider plugin with credentials

```yaml
name: my-provider
description: My provider integration

capabilities:
  - api.read
  - api.write

config-keys:
  - org
  - project

credentials:
  type: oauth-bearer
  api-domains:
    - api.example.com
  api-headers:
    X-Api-Version: "2026-01-01"
  auth-token-env: EXAMPLE_AUTH_TOKEN
  auth-token-placeholder: host_managed_credential

oauth:
  client-id-env: EXAMPLE_CLIENT_ID
  client-secret-env: EXAMPLE_CLIENT_SECRET
  authorize-endpoint: https://example.com/oauth/authorize
  token-endpoint: https://example.com/oauth/token
  authorize-params:
    audience: workspace
  token-auth-method: basic
  token-extra-headers:
    Content-Type: application/json

runtime-dependencies:
  - type: npm
    package: example-cli
  - type: system
    package: gh
  - type: system
    url: https://example.com/tool.rpm
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

runtime-postinstall:
  - cmd: example-cli
    args: ["install"]
```

### What the manifest fields mean

- `name`: unique lowercase plugin identifier; capabilities and config keys are qualified with it
- `description`: short summary of what the plugin integrates
- `capabilities`: actions the plugin’s skills may request, qualified as `<plugin>.<capability>`
- `config-keys`: provider-specific configuration keys, qualified as `<plugin>.<key>`
- `credentials`: how auth is delivered to tools; current types are `oauth-bearer` and `github-app`
- `oauth`: user OAuth setup; use it with `credentials.type: oauth-bearer`
- `target`: optional credential target scope tied to a declared config key
- `runtime-dependencies`: sandbox dependencies required by the plugin’s tools
- `runtime-postinstall`: commands that run after dependency install and before snapshot capture
- `mcp`: optional MCP server configuration for provider-scoped tool sources
- `mcp.allowed-tools`: optional raw MCP tool-name allowlist when a plugin should expose only part of a provider's tool surface

### Add skills to the plugin

Put at least one skill under `skills/<skill-name>/SKILL.md` and reference the qualified capability or config tokens in frontmatter.

```yaml
requires-capabilities: my-provider.api.read
uses-config: my-provider.org my-provider.project
```

### Package it for discovery

Published plugin packages must include `plugin.yaml` and `skills` in `files`.

```json
{
  "name": "@acme/junior-example",
  "private": false,
  "type": "module",
  "files": ["plugin.yaml", "skills"]
}
```

Then install it in the host app:

```bash
pnpm add @acme/junior-example
```

After install, add the package name to `pluginPackages` in `createApp(...)`.

## Validate extensions

```bash
pnpm skills:check
```
