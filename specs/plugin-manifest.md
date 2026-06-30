# Plugin Manifest Spec

## Metadata

- Created: 2026-05-28
- Last Edited: 2026-06-30

## Purpose

Define the `plugin.yaml` contract agents need when adding or reviewing provider plugins.

## Scope

- Required and optional manifest fields.
- Runtime dependency and command env declarations.
- MCP endpoint declaration.
- Manifest validation rules.

## Non-Goals

- Runtime loading order; see [Plugin Runtime Spec](./plugin-runtime.md).
- Credential issuance behavior; see [Credential Injection Spec](./credential-injection.md).
- OAuth callback behavior; see [OAuth Flows Spec](./oauth-flows.md).
- Resource event subscription handlers; see [Resource Event Subscriptions
  Spec](./resource-event-subscriptions.md). `plugin.yaml` may describe provider
  domains and credentials, but executable webhook/event behavior belongs in
  trusted app-code plugin hooks and core-owned subscription tools.

## Minimal Manifest

```yaml
name: sentry
display-name: Sentry
description: Sentry helper workflows
```

`name` must match `^[a-z][a-z0-9-]*$` and be globally unique. `display-name` is the human-facing provider label used in Slack and OAuth copy. `description` must be non-empty.

## Provider Manifest

```yaml
name: sentry
display-name: Sentry
description: Sentry issue tracking

capabilities:
  - api

config-keys:
  - org
  - project

credentials:
  type: oauth-bearer
  domains:
    - us.sentry.io
    - de.sentry.io
  auth-token-env: SENTRY_AUTH_TOKEN
  auth-token-placeholder: host_managed_credential

oauth:
  client-id-env: SENTRY_CLIENT_ID
  client-secret-env: SENTRY_CLIENT_SECRET
  authorize-endpoint: https://sentry.io/oauth/authorize/
  token-endpoint: https://sentry.io/oauth/token/
  scope: "event:read org:read project:read team:read"

target:
  type: project
  config-key: sentry.project
  command-flags:
    - --project
```

## Field Rules

- `capabilities`: short names qualified to `<plugin>.<capability>` by the registry.
- `display-name`: required provider label for human-facing auth and Slack text, for example `GitHub`, `Notion`, or `Sentry`.
- `config-keys`: short names qualified to `<plugin>.<key>` by the registry.
- `domains`: plugin-level domains for API header injection or code-based plugin egress hooks. Required when `api-headers` is set. In `plugin.yaml`, `domains` must pair with `api-headers` or `credentials`.
- `api-headers`: headers injected for matching `domains`. Secret values must come from `${NAME}` placeholders declared in `env-vars` without defaults.
- `credentials.type`: `"oauth-bearer"` only. Plugin-owned egress credentials are not declared in `credentials`; code-based plugins declare top-level `domains` and register both `grantForEgress` and `issueCredential`.
- `credentials.domains`: domains that receive generic OAuth bearer credential headers.
- `credentials.auth-token-env`: sandbox placeholder env var name. Required for `oauth-bearer` credentials, where it can also name a static host token used outside credential-context-bound turns.
- `credentials.auth-token-placeholder`: optional non-secret sandbox env value for CLI compatibility.
- `credentials.api-headers`: optional extra headers for `oauth-bearer` credentials only.
- `oauth`: required for OAuth bearer providers. Code-based plugins may also declare OAuth without `credentials` so egress credential hooks can request user authorization when a plugin-defined grant needs it. Endpoints must be HTTPS.
- `target.config-key`: must appear in `config-keys`.
- `runtime-dependencies`: optional sandbox dependencies. `type` is `"npm"` or `"system"`.
- `runtime-postinstall`: optional commands run after dependency install and before snapshot capture.
- `mcp`: optional hosted HTTP MCP server declaration. Stdio/command transports are not supported.

## Env Var References

`env-vars` declares every deployment env var a manifest may reference from `mcp.url`, plugin-level `api-headers`, or `command-env`.

```yaml
env-vars:
  EXAMPLE_AUTH_HEADER:
  EXAMPLE_SITE:
    default: example.com
  EXAMPLE_SAFE_TOKEN:
    expose-to-command-env: true

api-headers:
  Authorization: ${EXAMPLE_AUTH_HEADER}

command-env:
  EXAMPLE_API_KEY: host_managed_credential
  EXAMPLE_SITE: ${EXAMPLE_SITE}
  EXAMPLE_SAFE_TOKEN: ${EXAMPLE_SAFE_TOKEN}
```

Rules:

1. Placeholder syntax is only `${NAME}`.
2. `NAME` must match `[A-Z_][A-Z0-9_]*`.
3. Placeholders must be declared in `env-vars`.
4. `api-headers` placeholders must not have defaults.
5. `mcp.url` and default-backed `command-env` placeholders expand at manifest load.
6. `command-env` references without defaults require `expose-to-command-env: true`, bind from host env when sandbox command env is built, and are omitted when unset.
7. Secret-like values may be exposed through `command-env` only when they are intentionally safe for the sandbox. Provider auth values that must stay host-only belong in `api-headers`, `oauth`, or `credentials`.

## Runtime Dependencies

```yaml
runtime-dependencies:
  - type: npm
    package: sentry
  - type: system
    package: gh
  - type: system
    url: https://example.com/tool.rpm
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

runtime-postinstall:
  - cmd: example-cli
    args: ["install"]
```

System dependency environment:

- Sandbox OS is Amazon Linux 2023.
- System installs run via `dnf`.
- Direct URL installs must be HTTPS RPMs with `sha256`.
- Install commands run with root privileges.

Snapshot build/reuse is defined in [Sandbox Snapshots Spec](./sandbox-snapshots.md).

## MCP

```yaml
mcp:
  url: https://mcp.example.com/mcp
  headers:
    X-Workspace: acme
  allowed-tools:
    - search
    - fetch
```

Rules:

- `mcp.url` must be HTTPS after env-var expansion.
- `mcp.headers` may contain static non-Authorization headers.
- `Authorization` is reserved for runtime-managed auth.
- `allowed-tools` filters raw MCP tool names before exposure and activation fails if any listed tool is missing.

## Validation

- Parse all manifests before registering any plugin.
- Fail startup on validation errors.
- No duplicate plugin names.
- No duplicate qualified capability tokens.
- No duplicate effective provider egress domains after app-level `PluginCatalogConfig` merges.
- `command-env` may stand alone and must not force a plugin to claim provider egress domains.
- `plugin.yaml` is the enforceable runtime authority; skill prose cannot override it.

## Related Specs

- `./plugin.md`
- `./plugin-runtime.md`
- `./credential-injection.md`
- `./sandbox-snapshots.md`
- `./resource-event-subscriptions.md`
