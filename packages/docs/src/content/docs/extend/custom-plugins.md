---
title: Custom Plugins
description: Create and package your own Junior plugin with optional capabilities, optional credentials, and skills.
---

Custom plugins are declarative: they bundle a manifest (`plugin.yaml`) plus skills. The runtime discovers and wires capabilities from the manifest, so most integrations need little or no custom runtime code.

## Plugin structure

```text
my-junior-plugin/
├── package.json
├── plugin.yaml
└── skills/
    └── my-provider/
        └── SKILL.md
```

## Manifest examples

### Bundle-only plugin

```yaml
name: my-provider
description: Internal workflow bundles
```

### Credentialed provider plugin

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
  auth-token-env: EXAMPLE_AUTH_TOKEN
  auth-token-placeholder: host_managed_credential

oauth:
  client-id-env: EXAMPLE_CLIENT_ID
  client-secret-env: EXAMPLE_CLIENT_SECRET
  authorize-endpoint: https://example.com/oauth/authorize
  token-endpoint: https://example.com/oauth/token
  scope: "read write"

runtime-dependencies:
  - type: npm
    package: example-cli
```

## `name`

`name` is the unique plugin identifier and prefixes contributed capability/config tokens. Use lowercase and hyphen-safe names (`^[a-z][a-z0-9-]*$`).

## `description`

`description` is a short human-readable summary of what the plugin integrates.

## `capabilities`

`capabilities` are optional short names that the runtime qualifies as `<plugin>.<capability>`. Use this list to define what credentials and actions skills may request.

## `config-keys`

`config-keys` are optional provider-specific runtime configuration keys. They are qualified as `<plugin>.<key>`.

## `credentials`

`credentials` is optional. When present, it defines how auth is delivered to tools. Supported `type` values are:

- `oauth-bearer`
- `github-app`

Common fields:

- `api-domains`
- `auth-token-env`
- `auth-token-placeholder` (optional)

For `github-app`, include app-specific env mappings (`app-id-env`, `private-key-env`, `installation-id-env`).

## `oauth`

Use this section when the provider supports user OAuth. Include:

- `client-id-env`
- `client-secret-env`
- `authorize-endpoint`
- `token-endpoint`
- `scope`

If omitted, plugin auth is treated as non-OAuth. `oauth` requires `credentials.type: oauth-bearer`.

## `target`

Optional credential target scope for provider operations. `target.config-key` must also exist in `config-keys`.

## `runtime-dependencies`

Optional sandbox dependency declarations for CLI/tools required by skills.

- `type: npm` with `package` and optional `version`
- `type: system` with system package name

## `mcp`

Optional MCP server configuration block for external tool sources. Keep this provider-scoped and explicit.

## Skills in plugins

Add at least one skill under `skills/<skill-name>/SKILL.md`, and reference qualified capability/config tokens in skill frontmatter.

```yaml
requires-capabilities: my-provider.api.read
uses-config: my-provider.org my-provider.project
```

## Packaging for discovery

Published plugin packages must include `plugin.yaml` and `skills` in package `files`.

```json
{
  "name": "@acme/junior-example",
  "private": false,
  "type": "module",
  "files": ["plugin.yaml", "skills"]
}
```

## Install in host app

```bash
pnpm add @acme/junior-example
```

After install, runtime discovery registers plugin capabilities/config keys and loads skills automatically.
