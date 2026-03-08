# Plugins

Use this guide to create a plugin for your own Junior repository.

## What a Plugin Is

A plugin adds:

- Optional capabilities (for `requires-capabilities`)
- Optional config keys (for `uses-config`)
- Optional credential broker configuration
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

## `plugin.yaml` Templates

### Bundle-only plugin (skills only)

```yaml
name: linear
description: Linear helper workflows
```

### Credentialed provider plugin

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

runtime-dependencies:
  - type: npm
    package: sentry
    # version omitted => latest
  - type: system
    package: gh
  - type: system
    url: https://example.com/tool.rpm
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

runtime-postinstall:
  - cmd: agent-browser
    args: [install]
```

## Manifest Rules

- `name` must match `^[a-z][a-z0-9-]*$`
- `capabilities` and `config-keys` are optional; when present they use short names in YAML
- Junior qualifies them automatically:
  - `issues.read` becomes `<name>.issues.read`
  - `org` becomes `<name>.org`
- `credentials` is optional; when present, `credentials.type` must be `oauth-bearer` or `github-app`
- `oauth` requires `credentials.type: oauth-bearer`
- Plugins can declare capabilities without credentials, but `jr-rpc issue-credential` will fail with a clear no-credentials error.
- `runtime-dependencies` is optional and supports `npm` and `system` installers
- `runtime-dependencies[].version` is optional for `npm` (`latest` when omitted) and must be omitted for `system`
- `runtime-dependencies` system entries support either `package` (repo package name) or `url` + `sha256` (direct RPM install with checksum verification)
- `runtime-postinstall` is optional and runs declarative post-install commands after dependency installation and before snapshot capture
- `plugin.yaml` is required

## System Runtime Dependency Notes

- Sandbox OS is Amazon Linux 2023.
- System dependencies are installed with `dnf`.
- System package installs require root privileges; sandbox commands must set `sudo: true` for those install steps.

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
