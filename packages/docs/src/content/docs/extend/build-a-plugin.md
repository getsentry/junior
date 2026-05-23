---
title: Build a Plugin
description: Package a Junior provider integration with a manifest, optional skills, and runtime dependency declarations.
type: tutorial
summary: Create a plugin package that Junior can bundle, validate, and load at runtime.
prerequisites:
  - /extend/
related:
  - /concepts/skills-and-plugins/
  - /concepts/credentials-and-oauth/
  - /cli/check/
---

Build a plugin when an integration needs a reviewed manifest for provider domains, credentials, OAuth, MCP endpoints, runtime dependencies, or bundled provider skills.

Use local `app/plugins` while iterating in one app. Publish an npm package when more than one app or team should use the integration.

## Package layout

Use the same shape locally and in packages:

```text title="Plugin package"
my-junior-plugin/
├── package.json
├── plugin.yaml
└── skills/
    └── my-provider/
        └── SKILL.md
```

The package must include the manifest and skills in `package.json`:

```json title="package.json"
{
  "name": "@acme/junior-my-provider",
  "type": "module",
  "files": ["plugin.yaml", "skills"]
}
```

## Minimal manifest

A plugin can be manifest-only:

```yaml title="plugin.yaml"
name: my-provider
description: Internal workflow bundles
```

Add credential, MCP, API header, command env, and runtime dependency declarations only when the provider needs them.

## Provider manifest

Provider integrations should declare the authority surface in the manifest instead of hiding it in skill instructions:

```yaml title="plugin.yaml"
name: my-provider
description: My provider integration

credentials:
  type: oauth-bearer
  domains:
    - api.my-provider.example
  auth-token-env: MY_PROVIDER_AUTH_TOKEN
  auth-token-placeholder: host_managed_credential

oauth:
  client-id-env: MY_PROVIDER_CLIENT_ID
  client-secret-env: MY_PROVIDER_CLIENT_SECRET
  authorize-endpoint: https://my-provider.example/oauth/authorize
  token-endpoint: https://my-provider.example/oauth/token

mcp:
  url: https://api.my-provider.example/mcp
```

This lets Junior validate and load the provider surface before a turn starts.
Bundled skills are discovered from the package `skills/` directory; they are
not listed inside `plugin.yaml`.

## Runtime dependencies

If a skill needs a CLI or system package inside the sandbox, declare that in `plugin.yaml`:

```yaml title="plugin.yaml"
runtime-dependencies:
  - type: npm
    package: my-provider-cli
    version: 1.2.3

runtime-postinstall:
  - cmd: my-provider-cli
    args: ["install-assets"]
```

Junior merges runtime dependency declarations from all loaded plugins and prepares them with `junior snapshot create`.

## Register the package

Install the plugin next to `@sentry/junior`, then list it in `juniorNitro`:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  modules: [
    juniorNitro({
      plugins: {
        packages: ["@acme/junior-my-provider"],
      },
    }),
  ],
});
```

Do not use the removed `pluginPackages` option. `junior check` rejects it.

## Validate

Run validation before deploy:

```bash
pnpm exec junior check
pnpm exec junior snapshot create
```

`junior check` validates manifest and skill structure. `junior snapshot create` verifies runtime dependency snapshot inputs when your plugin declares them.

## Next step

Use [Plugins](/extend/) for packaged plugin registration, then verify auth behavior with [Plugin Auth & Context](/reference/runtime-commands/).
