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

| Field                  | Purpose                     | Rules                                                                                          |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `capabilities`         | provider permissions        | short tokens, qualified as `<plugin>.<capability>`                                             |
| `config-keys`          | defaults/targets            | short tokens, qualified as `<plugin>.<key>`                                                    |
| `env-vars`             | allowed deployment env refs | keys match `[A-Z_][A-Z0-9_]*`                                                                  |
| `domains`              | header injection domains    | required with `api-headers`                                                                    |
| `api-headers`          | literal/env-backed headers  | values may use declared `${NAME}`                                                              |
| `credentials`          | token delivery              | `oauth-bearer` or `plugin-managed`; plugin-managed requires trusted grant and credential hooks |
| `oauth`                | user OAuth                  | requires `credentials.type: oauth-bearer`, or `plugin-managed` when plugin hooks issue grants  |
| `target`               | target/config metadata      | `config-key` must be in `config-keys`                                                          |
| `runtime-dependencies` | sandbox packages            | `npm` or `system`                                                                              |
| `runtime-postinstall`  | setup commands              | `cmd`, optional `args`, optional `sudo`                                                        |
| `mcp`                  | hosted HTTP MCP             | HTTPS `url`, optional `allowed-tools`                                                          |

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

## Trusted Plugin Credentials

`plugin-managed` credentials are defined by a trusted code plugin, not by extra
provider-specific manifest fields. The manifest declares domains and sandbox
placeholder names; the plugin hooks choose grants and issue credential leases.

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
- `domains` requires `api-headers`.
- `oauth` requires `credentials.type: oauth-bearer` or `plugin-managed`.
- `mcp.url` env refs must be declared in `env-vars`.
- API-header env refs must not declare defaults.
- `command-env` env refs must not reuse API-header, credential, or OAuth env vars.
- `Authorization` is reserved inside `oauth-bearer` `credentials.api-headers`.
- `target.config-key` must be listed in `config-keys`.
- System dependencies must not declare `version`.
- System URL dependencies require HTTPS `url` plus 64-char hex `sha256`.
