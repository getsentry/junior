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
Identical declarations are deduplicated. Plugins that declare different versions of the same npm package cannot share a snapshot, so snapshot creation fails until their versions agree.

## Register the package

Install the plugin next to `@sentry/junior`, then add the package name to a
runtime-safe plugin set:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@acme/junior-my-provider"]);
```

Point `juniorNitro({ plugins: "./plugins" })` at that module and let
`createApp()` read the enabled set from Nitro's virtual module.

## Add runtime hooks

Most plugins should stay manifest-only. Use a JavaScript plugin definition only
when the plugin must force deterministic behavior at a Junior-owned boundary,
such as installing sandbox helper files or mutating tool input/env before
execution. Hooks are backend code and must be registered explicitly from
app code; Junior never loads them from `plugin.yaml`.

Hook contexts include `ctx.plugin` and `ctx.log`. Use `ctx.log` for
plugin-scoped structured logs instead of writing directly to stdout.

Export one factory from the plugin package. Name it after the plugin domain
followed by `Plugin`, such as `myProviderPlugin`. The factory must remain
callable even when it accepts no options:

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

Do not prefix the public factory with `create` or export a prebuilt registration
under the domain name. A single callable `<domain>Plugin(options?)` export keeps
registration consistent across plugins. Call it as `myProviderPlugin()` when it
has no configuration, or pass options when the package defines them.

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

### Runtime hooks

Use the smallest surface that matches the deterministic boundary your plugin needs:

| Surface                  | Purpose                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandboxPrepare(ctx)`    | Prepare files or runtime state inside a sandbox before agent tools run.                                                                                                                      |
| `beforeToolExecute(ctx)` | Deny or rewrite object-shaped tool input and set non-secret env values before a tool runs.                                                                                                   |
| `afterMcpTool(ctx)`      | Run junior-owned side effects after a successful hosted MCP tool call. Prefer this for conversation annotations instead of inventing a parallel tool contract.                               |
| `tools(ctx)`             | Return host-registered tool definitions for the current turn. Tool names must be plugin-local camelCase names.                                                                               |
| `heartbeat(ctx)`         | Run bounded periodic work from Junior's internal heartbeat route.                                                                                                                            |
| `apiRoutes(ctx)`         | Return a Hono or fetch-compatible app mounted under `/api/plugins/:pluginName/*` with auth already applied. Use `ctx.users.resolve(email)` only when the route must link work to one person. |
| `tasks`                  | Register plugin-owned background tasks. V1 tasks run after completed sessions and load bounded run context with `ctx.run.load()`.                                                            |

`tools(ctx)` receives the active turn context, `ctx.state`, and `ctx.log`. Call
`ctx.users.resolveActor()` only when a tool needs the active actor's linked
identity or user. Return tool definitions keyed by the plugin-local tool
names your plugin owns.
Junior exposes them to the agent as `<pluginNamespace>_<toolName>`, where
`pluginNamespace` is derived from the plugin manifest name. For example,
`my-provider` tool `ping` is exposed as `myProvider_ping`.

```ts title="index.ts"
import {
  defineJuniorPlugin,
  pluginToolOutputSchema,
  zodTool,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const pingOutputSchema = pluginToolOutputSchema.extend({
  latency_ms: z.number(),
});

export function myProviderPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "my-provider",
      description: "My provider integration",
    },
    hooks: {
      tools(ctx) {
        return {
          ping: zodTool({
            approvalMode: "auto",
            annotations: {
              readOnlyHint: true,
              openWorldHint: true,
            },
            description: "Check my-provider connectivity.",
            inputSchema: z.object({}),
            outputSchema: pingOutputSchema,
            privateTraceResult: (result) => ({
              latency_ms: result.latency_ms,
            }),
            execute: async () => {
              ctx.log.info("Running my-provider ping");
              return {
                latency_ms: 12,
              };
            },
          }),
        };
      },
    },
  });
}
```

The output schema describes the tool's successful value directly. Do not wrap
it in generic `ok`, `status`, or `data` fields. Throw `PluginToolInputError` for
model-repairable failures; Junior projects successful values and thrown errors
onto the agent runtime's separate result channels.

Use `approvalMode: "auto"` when Junior should review an action according to its
annotations and source. Use `review` when every tool call requires review. Use
`approve` only when the tool is safe to run without review. Omitting the
field leaves the tool outside action review.

Annotations describe side effects; they do not authorize an action. Junior
selects and enforces the reviewer. Add `describeProposal(input)` only when a
short domain-specific summary makes the reviewed semantic action clearer.
Review runs after `replaceInput`, while values added through `ctx.env` remain
execution-only. Keep action targets and side effects in typed input so Guardian
can review them.

Use `privateTraceResult` only for fields that are safe to retain when the
conversation is private. Without it, Junior records bounded result metadata
instead of the raw structured result.

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
