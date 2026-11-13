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

### Pre-registered MCP OAuth clients

Junior registers itself as an OAuth client when an MCP server asks a user to
authorize. Some authorization servers do not support dynamic client
registration. For these servers, declare `mcp.oauth-client` with the client
that you registered:

```yaml title="plugin.yaml"
env-vars:
  MY_PROVIDER_MCP_CLIENT_ID:
  MY_PROVIDER_MCP_CLIENT_SECRET:

mcp:
  url: https://api.my-provider.example/mcp
  oauth-client:
    client-id-env: MY_PROVIDER_MCP_CLIENT_ID
    client-secret-env: MY_PROVIDER_MCP_CLIENT_SECRET
    scope: my-provider.readonly
    authorize-params:
      access_type: offline
```

Set the client redirect URI to
`<JUNIOR_BASE_URL>/api/oauth/callback/mcp/<plugin-name>`. Junior requests
`scope` instead of the scopes that the MCP server advertises. Use it to keep a
plugin read-only. `authorize-params` adds provider-specific parameters to the
authorization URL. Do not declare both `mcp.auth` and `mcp.oauth-client`.

### Service accounts

Per-user OAuth is the default. A plugin can also let Junior use one shared
provider account, often a bot, for people who have not connected their own
account. This account usually has fewer permissions than a person.

Use the `accounts` block to say which accounts Junior may use. The service
account lists exactly the tools that it may call:

```yaml title="plugin.yaml"
mcp:
  url: https://api.my-provider.example/mcp
  allowed-tools:
    - search
    - fetch
    - create-page

accounts:
  service-account:
    tools:
      - search
      - fetch
```

- `accounts.service-account.tools` lists the MCP tools that the shared
  account may call. Each tool must be in `mcp.allowed-tools` or
  `mcp.wrapped-tools`. Junior calls MCP servers from the host, so it checks
  each tool call against this list. Leave out `service-account` when the
  plugin has no service account.
- `accounts.user-oauth` is `true` by default. Set it to `false` when people
  must not use their own accounts. Then Junior uses only the service account,
  never asks a person to connect, and ignores connections that people already
  made. Junior hides the tools that the service account does not list. Until
  an admin connects the account, the plugin is not available.
  `user-oauth: false` requires `service-account`.
- You cannot use `service-account` with `mcp.auth` or `mcp.oauth-client`.
  Plugins with only a top-level `oauth` block do not support a service
  account yet.
- Junior rejects unknown keys in `accounts`, so a typo cannot change which
  accounts Junior uses.

The declaration has no effect until a Junior admin connects the account. In
the dashboard, open **Admin**, find the plugin under **Service accounts**, and
click **Connect**. Sign in as the account that Junior uses, not as yourself.
The same card shows who connected the account and lets an admin disconnect it.

If the dashboard is not available, an operator can use the CLI on a machine
with a browser and the deployment `REDIS_URL`:

```bash
junior service-account connect my-provider
junior service-account status my-provider
junior service-account disconnect my-provider
```

When the account is connected, Junior uses it only for an actor who has not
connected their own account, and only for the tools that it lists.
Other requests ask the actor to connect their own account, as before. An
actor's own connection always wins. Everyone who can talk to Junior can read what the
service account can read, so give that account only the access that all of
them may have.

### Audit events

Each successful MCP tool call emits the `mcp.tool_call.completed` audit event.
Sentry keeps audit events in production. The event records the accountable
person, the Conversation, the run Source, the tool, and the account that made
the call: `service_account` or `actor`. It does not record the tool arguments.
The Conversation history keeps them.

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
| `beforeToolExecute(ctx)` | Deny, redirect, or rewrite object-shaped tool input and set non-secret env values before a tool runs.                                                                                        |
| `afterToolExecute(ctx)`  | Check a finished tool call, such as the files it changed. Add guidance to its result or reject the result.                                                                                   |
| `afterMcpTool(ctx)`      | Run junior-owned side effects after a successful hosted MCP tool call. Prefer this for conversation annotations instead of inventing a parallel tool contract.                               |
| `tools()`                | Return the plugin's tool definitions. They take no Turn context. Tool names must be plugin-local camelCase names.                                                                            |
| `disabledTools(ctx)`     | Return a reason for each tool that the current Turn cannot use, keyed by plugin-local tool name.                                                                                             |
| `heartbeat(ctx)`         | Run bounded periodic work from Junior's internal heartbeat route.                                                                                                                            |
| `apiRoutes(ctx)`         | Return a Hono or fetch-compatible app mounted under `/api/plugins/:pluginName/*` with auth already applied. Use `ctx.users.resolve(email)` only when the route must link work to one person. |
| `tasks`                  | Register plugin-owned background tasks. V1 tasks run after completed sessions and load bounded run context with `ctx.run.load()`.                                                            |

When a hook, tool, or task belongs to a Conversation, Junior records the cost
of each `ctx.model`, `ctx.decider`, `ctx.embedder`, and `ctx.reranker` call.
The Conversation cost includes it. Do not put `costUsd` on your own events,
because Junior then counts that cost two times. To show model cost in a plugin
report, read `pluginModelCostEventNames` events with `ctx.eventStats`.

In `beforeToolExecute`, `ctx.decision` can stop a tool call before it runs:

- `ctx.decision.redirect(message)`: a different path is correct. The message
  tells the agent what to do instead, for example "Use `myProvider_clone`."
- `ctx.decision.deny(reason)`: a policy refusal. Junior tells the agent not to
  retry or work around the block, and to explain it.

Both return the message to the agent as the tool result. Neither ends the
turn, and neither is reported to Sentry as an exception.

`afterToolExecute` runs after each tool call that finishes without an error,
including `bash` and Code Mode script calls. Return early for tools that the
check does not cover. `ctx.sandbox` runs commands in the Run's sandbox, and
`ctx.workspace` gives the active Workspace name and its repositories with their
checkout paths. To run a check in some Workspaces only, return early when
`ctx.workspace?.name` is not one of them. Use `ctx.decider.decide(...)` for a fast classifier choice, or
`ctx.model.completeObject(...)` for a judgment that needs reasoning.

- `ctx.decision.nudge(message)`: add guidance after the tool result. The agent
  reads both. The tool output does not change, so JSON output stays valid. In
  a Code Mode script, the script gets the unchanged value, and the guidance
  shows under that call in the `codemode` result.
- `ctx.decision.deny(reason)`: replace the result with a policy refusal. The
  tool already ran, so undo its effects first when they must not stay.

A hook that throws is logged, and the tool result stays unchanged.

`tools()` takes no arguments and returns the same definitions in every Turn.
Junior reads them for the static tool registry with no Turn. Each tool gets the active
Turn context as the third argument of `execute(input, options, ctx)`, with
`ctx.state` and `ctx.log`. Call `ctx.users.resolveActor()` only when a tool needs the active actor's linked
identity or user. Call `ctx.users.resolveTimezone()` when a tool needs the
active actor's IANA timezone. It returns the install default when Junior does
not know the person's timezone. A tool that sends model text to your provider
must call `ctx.users.replaceSlackMentions(input, provider)` first. The model
reads Slack threads, so it can copy Slack syntax such as `<@U123>`. The call
rewrites every string in `input`, outside Markdown code. A Slack user becomes
`@handle` of their linked account at `provider`, or their name. Return tool definitions keyed by the plugin-local tool
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
      tools() {
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
            execute: async (_input, _options, ctx) => {
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

`approvalMode` sets whether Guardian reviews a call before the tool runs:

- `auto` is the default. Junior sets it when you omit the field. A tool with
  `readOnlyHint: true` and no `destructiveHint: true` runs without review.
  Guardian reviews each call of every other tool in this mode. Set
  `readOnlyHint: true` only when the tool never writes.
- `review` makes Guardian review each call.
- `approve` skips review. The tool runs without a Guardian decision, also in a
  child agent.
- `confirm` makes Guardian review each call, and then requires the user's
  explicit confirmation of the exact input. Junior rejects the first call so
  that the agent asks. A later call with the same input runs only when the
  user confirmed it in between. An Automation run cannot confirm, so the call
  never runs there. Use `confirm` for effects that are hard to undo, such as
  creating a repository.

Use `approve` only when the tool code proves that each effect is safe, and no
model judgment is necessary. For example, the GitHub tools that mark feedback
and resolve review threads read the pull request from GitHub first. They refuse
unless the bot authored it. Their only effect is the bot's own reaction or the
resolved state of a thread, and you can undo both. Do not use `approve` when
the tool writes text that can make claims, or when the tool does not check its
target itself.

Annotations describe side effects; they do not authorize an action. Junior
selects and enforces the reviewer. Add `describeProposal(input)` only when a
short domain-specific summary makes the reviewed semantic action clearer.
Review runs after `replaceInput`, while values added through `ctx.env` remain
execution-only. Keep action targets and side effects in typed input so Guardian
can review them.

Use `privateTraceResult` only for fields that are safe to retain when the
conversation is private. Without it, Junior records bounded result metadata
instead of the raw structured result.

`tools()` cannot read the Turn, so the tool list stays the same in every Turn.
A change to the tool list invalidates the model provider's prompt cache. When
one Turn cannot use a tool, return a reason for it from `disabledTools(ctx)`.
Junior keeps the tool in the tool list, lists it as disabled in the Turn
context, and rejects its calls before review or execution.

```ts
disabledTools(ctx) {
  return ctx.source.kind === "agent_invocation"
    ? { ping: "Child agents cannot ping my-provider." }
    : {};
},
```

Every hook context has `ctx.cache`. Use it to keep short-lived copies of
provider reads, such as a user's role. It is not durable. Junior can drop an
entry at any time, so keep data that must survive in `ctx.state`. Return a
`ttlMs` to cache the value. Omit `ttlMs` to skip the cache for a result, such
as an incomplete response. A load that throws is not cached, and concurrent
callers for one key share one load.

```ts
const role = await ctx.cache.getOrLoad(`role:${repo}:${login}`, async () => ({
  value: await loadRole(repo, login),
  ttlMs: 10 * 60 * 1000,
}));
```

`heartbeat(ctx)` is for plugins that need server-side background work.
Use `ctx.state` for plugin-namespaced durable state. Use
`ctx.agent.dispatch(...)` when the heartbeat needs Junior to run an autonomous
agent task, and `ctx.agent.get(...)` to reconcile that dispatch later. Use
`ctx.events`, `ctx.annotations`, `ctx.codeChanges`, and `ctx.reviewItems` as
from a plugin route.

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
and receive projection records, not raw runtime state. Pass `title` to name
the dispatch Conversation. When you omit it, Junior generates one from
`input`.

## Add a link type

A link type turns a URL in a reply into an object card in the dashboard. It
works like an Android `<intent-filter>`. You declare static filters, and
Junior matches each URL against them without your code. Then Junior calls
`canView` of the most specific match, and calls its `resolve` only when
`canView` returns true.

```ts title="index.ts"
defineJuniorPlugin({
  manifest: { name: "my-provider", description: "My provider integration" },
  objectLinks: [
    {
      objectType: "task",
      filters: [{ host: "tracker.example.com", pathPattern: "/issues/*" }],
      async canView(ctx, url) {
        return await viewerCanOpenIssue(ctx.viewer, url);
      },
      async resolve(ctx, url) {
        const issue = await readIssue(ctx, url);
        if (!issue) return undefined;
        return {
          kind: "object",
          key: `issue:${issue.id}`,
          objectType: "task",
          label: issue.key,
          title: issue.title,
          url: issue.url,
          status: issue.status,
          facts: { type: "task", assignees: issue.assignees },
        };
      },
    },
  ],
});
```

- **Filter.** `scheme` is `https` when you omit it. `host` is an exact host
  or `*.example.com`. Give one of `path` (exact), `pathPattern` (a `*`
  segment matches one segment), or `pathPrefix`. Junior picks an exact host
  before a wildcard host, and an exact path before a pattern before a
  prefix. Two link types with equal filters for the same URLs stop app
  startup. An `https` URL that no link type claims gets a `web_page` card from core,
  from its oEmbed provider or its Open Graph tags. Your filter always wins
  over it.
- **Access.** `canView` is required. Return true only when `ctx.viewer` can
  open the object, and false when you cannot tell. For a public object,
  return true. `ctx.egress` calls your provider as a system Actor. It gets
  only credentials that your plugin owns, never the viewer's, so `canView`
  must check the viewer, not only that the call works.
  `ctx.viewerEgress` uses only the viewer's own stored OAuth token for your
  provider. It never asks the viewer to connect. A viewer without a token
  gets HTTP 401. Use it in `canView` to ask the provider whether the viewer
  can open the object. Junior calls `canView` before each card read and
  again on each Attach.
- **Resolver.** Return the card, or `undefined` for a missing object. To
  share one provider read with `canView`, read through `ctx.cache` with a
  short TTL. Junior caches the card for one minute for each viewer and URL,
  and does not save it on a Conversation.
- **People.** For a profile link of a provider account, return
  `await ctx.findPerson({ provider, handle })` when it finds a card. That is
  the Junior person card of the one known person who linked that account.
- **Facts and icon.** Return the facts of `objectType`. Each object type has
  its label, icon, and tones in `@sentry/junior-plugin-api`. To add an object
  type, add it to `objectTypeSchema`, its facts to `object-facts.ts`, and an
  icon to `scripts/generate-object-icons.mjs`.
- **Test.** Test `canView` and the resolver for a viewer that can read the
  object, and for a viewer that cannot.

## Validate

Run validation before deploy:

```bash
pnpm exec junior check
```

`junior check` validates manifest and skill structure. The deploy build runs
`junior snapshot create`, which installs your runtime dependencies. Confirm that
its build log lists them.

## Next step

Use [Plugins](/extend/) for packaged plugin registration, then verify auth behavior with [Plugin Auth & Context](/reference/runtime-commands/).
