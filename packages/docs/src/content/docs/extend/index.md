---
title: Plugins
description: Where Junior plugins live, how to add them, and how to build your own.
type: tutorial
summary: Add packaged or local provider integrations to a Junior app.
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/build-a-plugin/
  - /extend/agent-browser-plugin/
  - /extend/datadog-plugin/
  - /extend/github-plugin/
  - /extend/hex-plugin/
  - /extend/linear-plugin/
  - /extend/notion-plugin/
  - /extend/scheduler-plugin/
  - /extend/sentry-plugin/
  - /extend/vercel-plugin/
---

Junior plugins are manifest-owned provider integrations. A plugin package can also ship skills that use that provider surface, but skills do not define plugin config, credentials, domains, OAuth scopes, MCP endpoints, or runtime dependencies.

## Where plugins live

A plugin declares:

- A manifest (`plugin.yaml`) that declares optional capabilities, optional config keys, and optional credential behavior.
- Optional skills (`SKILL.md`) that consume those capabilities at runtime.

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

For reuse across apps or teams, package plugin manifests and any bundled skills as npm packages and install them next to `@sentry/junior`.

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser @sentry/junior-datadog @sentry/junior-github @sentry/junior-hex @sentry/junior-linear @sentry/junior-notion @sentry/junior-scheduler @sentry/junior-sentry @sentry/junior-vercel
```

List the plugin packages in `juniorNitro` so they are bundled at build time and available at runtime:

```ts title="nitro.config.ts"
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: {
        packages: [
          "@sentry/junior-agent-browser",
          "@sentry/junior-datadog",
          "@sentry/junior-github",
          "@sentry/junior-hex",
          "@sentry/junior-linear",
          "@sentry/junior-notion",
          "@sentry/junior-scheduler",
          "@sentry/junior-sentry",
          "@sentry/junior-vercel",
        ],
      },
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

Use the same `plugins` config to adjust packaged manifest defaults at install time:

```ts title="nitro.config.ts"
juniorNitro({
  plugins: {
    packages: ["@sentry/junior-github"],
    manifests: {
      github: {
        credentials: {
          domains: ["api.github.com", "github.com"],
        },
        oauth: {
          scope: "repo read:org workflow",
        },
      },
    },
  },
});
```

If you publish your own package with bundled skills, include both `plugin.yaml` and `skills` in package `files`. Manifest-only packages can include just `plugin.yaml`.

## Trusted runtime hooks

Some packaged plugins also export trusted runtime hooks for deterministic
behavior that cannot live in skill prose or `plugin.yaml`. For example, the
scheduler plugin registers schedule-management tools and heartbeat behavior, and
the GitHub plugin installs a sandbox Git hook, configures global Git defaults,
and injects commit attribution env before bash commands run.

Trusted hooks are explicit app code:

```ts title="server.ts"
import { createApp } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { schedulerPlugin } from "@sentry/junior-scheduler";

const app = await createApp({
  plugins: [
    schedulerPlugin(),
    githubPlugin({
      botNameEnv: "GITHUB_APP_BOT_NAME",
      botEmailEnv: "GITHUB_APP_BOT_EMAIL",
    }),
  ],
});

export default app;
```

Do not put trusted code entrypoints in `plugin.yaml`; manifests stay
declarative. Use [Build a Plugin](/extend/build-a-plugin/) for the package
authoring contract.

## Local skills vs plugin skills

Junior discovers both:

- App-local skills in `app/skills/<skill-name>/SKILL.md`
- Plugin-provided skills under each plugin’s `skills/` root

Use `app/skills` for skills that do not belong to a plugin. Use plugin skills when the skill depends on provider-specific capabilities or config.

## Build your own plugin

Every custom plugin needs a `plugin.yaml`. Add bundled skills only when the package should also teach the agent provider-specific workflows.

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

domains:
  - api.example.com
api-headers:
  X-Api-Version: "2026-01-01"

credentials:
  type: oauth-bearer
  domains:
    - api.example.com
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
- `capabilities`: provider actions qualified as `<plugin>.<capability>`
- `config-keys`: provider-specific configuration keys, qualified as `<plugin>.<key>`
- `domains` and `api-headers`: optional host-managed HTTP headers applied when matching sandbox requests are proxied through Junior; each provider domain can belong to only one plugin
- `command-env`: optional non-secret sandbox env vars injected for registered credential/header providers; use it for CLI placeholders, deployment defaults, and public install metadata
- `credentials`: how token auth is delivered to tools; current types are `oauth-bearer` and `github-app`
- `oauth`: user OAuth setup; use it with `credentials.type: oauth-bearer`
- `target`: optional credential target scope tied to a declared config key
- `runtime-dependencies`: sandbox dependencies required by the plugin’s tools
- `runtime-postinstall`: commands that run after dependency install and before snapshot capture
- `mcp`: optional MCP server configuration for provider-scoped tool sources; `mcp.url` implies hosted HTTP transport, so `mcp.transport: http` is optional
- `env-vars`: optional map of deployment env vars the manifest may reference from `mcp.url`, `api-headers`, or `command-env`. Each key names an env var (uppercase, `[A-Z_][A-Z0-9_]*`) and may declare a `default` for `mcp.url` and `command-env`. Command-env references without defaults bind from host env when command env is resolved; API header references cannot use defaults.
- `mcp.url`: supports `${VAR}` placeholders that must be declared in `env-vars`. This lets region-pinned providers pick the right host at deploy time without a manifest fork.
- `mcp.allowed-tools`: optional raw MCP tool-name allowlist when a plugin should expose only part of a provider's tool surface

### Env-var expansion in `mcp.url`

Some providers (Sentry self-hosted, GitHub Enterprise, Linear EU, ...) have different hostnames per region or deployment. The packaged plugin manifest keeps a single `mcp.url` and declares the deployment-level env vars it may read in an `env-vars` block. Defaults live in the declaration, not inline in the URL:

```yaml
env-vars:
  EXAMPLE_SITE:
    default: example.com

mcp:
  url: https://mcp.${EXAMPLE_SITE}/mcp
```

The only supported placeholder form is `${NAME}` — replaced with `process.env[NAME]`, falling back to the declared `default`. Plugin discovery fails loudly at load time if `NAME` is not listed in `env-vars`, or if it is listed without a default and the env var is unset.

`NAME` must match `[A-Z_][A-Z0-9_]*`. Every env var a manifest references must be declared in `env-vars`; placeholders that escape the declared allowlist are rejected at load time, so a manifest cannot opportunistically read ambient secrets (e.g. `SLACK_BOT_TOKEN`) from the host process.

### API headers

Use top-level `api-headers` when a provider needs additional HTTP headers in sandbox requests. Junior applies these headers from the host when the sandbox egress proxy forwards a request to a matching `domains` entry. This can stand alone for header-authenticated providers or pair with token-backed credentials. When paired with token-backed credentials, the credential broker owns token headers such as `Authorization`; if both sources set the same header for the same domain, the credential header wins. Env-backed values use `${NAME}` placeholders declared in `env-vars`; unlike `mcp.url`, API header env vars cannot declare defaults because they may carry secrets.

```yaml
env-vars:
  EXAMPLE_AUTH_HEADER:

domains:
  - api.example.com

api-headers:
  Authorization: ${EXAMPLE_AUTH_HEADER}
  Content-Type: text/plain
```

Literal headers are also valid:

```yaml
domains:
  - api.example.com

api-headers:
  X-Api-Version: "2026-01-01"
```

### Command env

Use top-level `command-env` when a sandbox CLI needs non-secret env vars. This is commonly used for placeholder auth env vars so the CLI proceeds to make HTTP requests while Junior injects the real credentials from the host.

`command-env` values may be literals or `${NAME}` placeholders declared in `env-vars`. References with defaults expand at manifest load. References without defaults are read from host env when sandbox command env is resolved and are skipped when unset.

Only expose non-secret values. `command-env` placeholders cannot reuse env vars that back `api-headers`, credential config, or OAuth config. For example, GitHub App bot names and noreply emails are safe to expose so git commits can be attributed correctly, but API keys and tokens belong in `api-headers` or credential brokers.

Manifests with `command-env` must also declare `credentials` or `api-headers`, so sandbox env exposure stays tied to a credential/header provider.

```yaml
env-vars:
  EXAMPLE_AUTH_HEADER:
  EXAMPLE_SITE:
    default: example.com
  EXAMPLE_BOT_EMAIL:

domains:
  - api.example.com
api-headers:
  Authorization: ${EXAMPLE_AUTH_HEADER}

command-env:
  EXAMPLE_API_KEY: host_managed_credential
  EXAMPLE_SITE: ${EXAMPLE_SITE}
  EXAMPLE_BOT_EMAIL: ${EXAMPLE_BOT_EMAIL}
```

### Optionally add skills to the plugin

Put bundled provider workflows under `skills/<skill-name>/SKILL.md`. Provider config keys belong in `plugin.yaml`, not in skill frontmatter.

```yaml
---
name: my-provider
description: Work with My Provider resources.
---
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

The `juniorNitro({ plugins: { packages: [...] } })` module includes `app/**/*` and the declared plugin package content in the deployed function bundle. The plugin list is automatically available at runtime via `createApp()` for declarative manifest behavior. Plugins that export trusted runtime hooks, such as `@sentry/junior-scheduler` and `@sentry/junior-github`, must also be registered from app code.

## Validate extensions

```bash
pnpm skills:check
```
