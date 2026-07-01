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

Manifest-only plugins use a data-only package:

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

Use a JavaScript plugin factory instead of `plugin.yaml` when the package needs
runtime hooks.

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

Install the plugin next to `@sentry/junior`, then add the package name to a
runtime-safe plugin set:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@acme/junior-my-provider"]);
```

Point `juniorNitro({ plugins: "./plugins" })` at that module and let
`createApp()` read the enabled set from Nitro's virtual module. Do not use the
removed `pluginPackages` or `plugins.packages` options; `junior check` rejects
both.

## Add runtime hooks

Most plugins should stay manifest-only. Use a JavaScript plugin definition only
when the plugin must force deterministic behavior at a Junior-owned boundary,
such as installing sandbox helper files or mutating tool input/env before
execution. Hooks are backend code and must be registered explicitly from
app code; Junior never loads them from `plugin.yaml`.

Hook contexts include `ctx.plugin` and `ctx.log`. Use `ctx.log` for
plugin-scoped structured logs instead of writing directly to stdout.

Export a factory from the plugin package:

```ts title="index.ts"
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

export function myProviderPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "my-provider",
      description: "My provider integration",
      configKeys: ["org"],
    },
    hooks: {
      async sandboxPrepare(ctx) {
        ctx.log.info("Preparing my-provider sandbox helpers");
        await ctx.sandbox.writeFile({
          path: `${ctx.sandbox.juniorRoot}/my-provider-ready`,
          content: "ok\n",
        });
      },
      beforeToolExecute(ctx) {
        if (ctx.tool.name === "bash") {
          ctx.env.set("MY_PROVIDER_NON_SECRET_FLAG", "1");
        }
      },
    },
  });
}
```

Do not ship `plugin.yaml` for the same plugin. The JavaScript definition owns
both the manifest surface and the hooks. If the same package also ships
`skills/`, add `packageName: "@acme/junior-my-provider"` so Nitro copies those
skills into the deployment bundle.

Enable the plugin from the app plugin module:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { myProviderPlugin } from "@acme/junior-my-provider";

export const plugins = defineJuniorPlugins([myProviderPlugin()]);
```

Use `ctx.decision.replaceInput(...)` only with object-shaped tool input. Junior
rejects non-object replacements before the tool runs.

### Runtime surfaces

Use the smallest surface that matches the deterministic boundary your plugin needs:

| Surface                  | Purpose                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandboxPrepare(ctx)`    | Prepare files or runtime state inside a sandbox before agent tools run.                                                                                                             |
| `beforeToolExecute(ctx)` | Deny or rewrite object-shaped tool input and set non-secret env values before a tool runs.                                                                                          |
| `tools(ctx)`             | Return host-registered tool definitions for the current turn. Tool names must be plugin-local camelCase names.                                                                      |
| `heartbeat(ctx)`         | Run bounded periodic work from Junior's internal heartbeat route.                                                                                                                   |
| `apiRoutes(ctx)`         | Return a Hono or fetch-compatible app mounted under `/api/plugins/:pluginName/*` with auth already applied. The app receives sanitized auth context as the second `fetch` argument. |
| `tasks`                  | Register plugin-owned background tasks. V1 tasks run after completed sessions and load bounded run context with `ctx.run.load()`.                                                   |

`tools(ctx)` receives the active turn context, `ctx.state`, and `ctx.log`.
Return tool definitions keyed by the plugin-local tool names your plugin owns.
Junior exposes them to the agent as `<pluginNamespace>_<toolName>`, where
`pluginNamespace` is derived from the plugin manifest name. For example,
`my-provider` tool `ping` is exposed as `myProvider_ping`.

```ts title="index.ts"
import { Type } from "@sinclair/typebox";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

export function myProviderPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "my-provider",
      description: "My provider integration",
    },
    hooks: {
      tools(ctx) {
        return {
          ping: {
            description: "Check my-provider connectivity.",
            inputSchema: Type.Object({}),
            execute: async () => {
              ctx.log.info("Running my-provider ping");
              return { ok: true };
            },
          },
        };
      },
    },
  });
}
```

`heartbeat(ctx)` is for plugins that need server-side background work.
Use `ctx.state` for plugin-namespaced durable state. Use
`ctx.agent.dispatch(...)` when the heartbeat needs Junior to run an autonomous
agent task, and `ctx.agent.get(...)` to reconcile that dispatch later.

```ts title="index.ts"
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

export function myProviderPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "my-provider",
      description: "My provider integration",
    },
    hooks: {
      async heartbeat(ctx) {
        const lastDispatch = await ctx.state.get<{ id: string }>(
          "last-dispatch",
        );
        if (lastDispatch) {
          const dispatch = await ctx.agent.get(lastDispatch.id);
          ctx.log.info("Checked background dispatch", {
            status: dispatch?.status ?? "missing",
          });
        }

        return { dispatchCount: 0 };
      },
    },
  });
}
```

Heartbeat dispatches are durable, signed, bounded, and scoped to the plugin
that created them. Plugins can dispatch only to validated Slack destinations
and receive projection records, not raw runtime state.

## Validate

Run validation before deploy:

```bash
pnpm exec junior check
pnpm exec junior snapshot create
```

`junior check` validates manifest and skill structure. `junior snapshot create` verifies runtime dependency snapshot inputs when your plugin declares them.

## Next step

Use [Plugins](/extend/) for packaged plugin registration, then verify auth behavior with [Plugin Auth & Context](/reference/runtime-commands/).
