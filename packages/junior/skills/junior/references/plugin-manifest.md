# Plugin Manifest

## Minimal

```yaml
name: my-provider
description: Internal provider workflows
```

## Required

| Field         | Rule                        |
| ------------- | --------------------------- |
| `name`        | `^[a-z][a-z0-9-]*$`, unique |
| `description` | non-empty string            |

## Optional

| Field                  | Purpose                     | Rules                                                                               |
| ---------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `capabilities`         | provider permissions        | short tokens, qualified as `<plugin>.<capability>`                                  |
| `config-keys`          | defaults/targets            | short tokens, qualified as `<plugin>.<key>`                                         |
| `env-vars`             | allowed deployment env refs | keys match `[A-Z_][A-Z0-9_]*`                                                       |
| `domains`              | header injection domains    | required with `api-headers`                                                         |
| `api-headers`          | literal/env-backed headers  | values may use declared `${NAME}`                                                   |
| `credentials`          | token delivery              | `oauth-bearer` in `plugin.yaml`; code plugins can own egress credentials with hooks |
| `oauth`                | user OAuth                  | requires `credentials.type: oauth-bearer` in `plugin.yaml`                          |
| `target`               | target/config metadata      | `config-key` must be in `config-keys`                                               |
| `runtime-dependencies` | sandbox packages            | `npm` or `system`                                                                   |
| `runtime-postinstall`  | setup commands              | `cmd`, optional `args`, optional `sudo`                                             |
| `mcp`                  | hosted HTTP MCP             | HTTPS `url`, optional `allowed-tools`                                               |

## OAuth bearer

```yaml
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
  scope: "read write"
```

## Plugin-Managed Credentials

Plugins with credential hooks declare egress domains in code and issue
credential leases from hooks. Do not put `plugin-managed` in `plugin.yaml`;
manifest credential declarations are for generic OAuth bearer credentials.

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";

export const plugins = defineJuniorPlugins([githubPlugin()]);
```

## MCP + headers

```yaml
env-vars:
  EXAMPLE_SITE:
    default: example.com
  EXAMPLE_AUTH_HEADER:

domains:
  - api.example.com
api-headers:
  Authorization: ${EXAMPLE_AUTH_HEADER}

mcp:
  url: https://mcp.${EXAMPLE_SITE}/mcp
  allowed-tools:
    - search
    - fetch
```

## Parser traps

- `api-headers` requires `domains`.
- `domains` requires `api-headers` in `plugin.yaml`.
- `oauth` requires `credentials.type: oauth-bearer` in `plugin.yaml`.
- `mcp.url` env refs must be declared in `env-vars`.
- API-header env refs must not declare defaults.
- `command-env` env refs must not reuse API-header, credential, or OAuth env vars.
- `Authorization` is reserved inside `oauth-bearer` `credentials.api-headers`.
- `target.config-key` must be listed in `config-keys`.
- System dependencies must not declare `version`.
- System URL dependencies require HTTPS `url` plus 64-char hex `sha256`.
