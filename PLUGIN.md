# Plugins

Use this guide to create a plugin for your own Junior repository.

## What a Plugin Is

A plugin adds:

- Capabilities (for `requires-capabilities`)
- Config keys (for `uses-config`)
- Credential broker configuration
- Optional OAuth provider configuration
- Skills under the plugin's `skills/` directory

## Local Plugin Setup

Create this directory in your app:

```text
app/plugins/<plugin-name>/
  plugin.yaml
  skills/
    <skill-name>/
      SKILL.md
```

Example:

```text
app/plugins/linear/
  plugin.yaml
  skills/
    linear/
      SKILL.md
```

## `plugin.yaml` Template

```yaml
name: linear
description: Linear issue workflows

capabilities:
  - issues.read
  - issues.write

config-keys:
  - org
  - team

credentials:
  type: oauth-bearer
  api-domains:
    - api.linear.app
  auth-token-env: LINEAR_API_TOKEN
  auth-token-placeholder: host_managed_credential

oauth:
  client-id-env: LINEAR_CLIENT_ID
  client-secret-env: LINEAR_CLIENT_SECRET
  authorize-endpoint: https://linear.app/oauth/authorize
  token-endpoint: https://api.linear.app/oauth/token
  scope: read,write
```

## Manifest Rules

- `name` must match `^[a-z][a-z0-9-]*$`
- `capabilities` and `config-keys` use short names in YAML
- Junior qualifies them automatically:
  - `issues.read` becomes `<name>.issues.read`
  - `org` becomes `<name>.org`
- `credentials.type` must be `oauth-bearer` or `github-app`
- `plugin.yaml` is required

## Distribute Plugins as npm Packages

You can publish plugin content as an npm package and Junior will auto-detect it.

### Package Layout

```text
@your-scope/junior-plugin-linear/
  package.json
  plugin.yaml
  skills/
    linear/
      SKILL.md
```

`plugin.yaml` must be at the package root.

### In the Consumer App

1. Install your plugin package:

```bash
pnpm add @your-scope/junior-plugin-linear
```

2. Deploy as normal. Junior auto-detects installed dependencies that contain:
- `plugin.yaml` at package root
- `plugins/` directory
- `skills/` directory

## Multiple Plugin Packages

Install multiple packages with `pnpm add` and Junior will discover each one automatically.

## Troubleshooting

- If the plugin does not load, verify:
  - The package is installed in dependencies
  - `plugin.yaml` is present at package root
  - `name` and manifest fields pass validation
  - Skills are under `<package>/skills/`
  - Plugin folders are under `<package>/plugins/<name>/plugin.yaml`
