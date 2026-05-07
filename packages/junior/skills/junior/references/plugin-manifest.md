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

| Field                  | Purpose                     | Rules                                              |
| ---------------------- | --------------------------- | -------------------------------------------------- |
| `capabilities`         | provider permissions        | short tokens, qualified as `<plugin>.<capability>` |
| `config-keys`          | defaults/targets            | short tokens, qualified as `<plugin>.<key>`        |
| `env-vars`             | allowed deployment env refs | keys match `[A-Z_][A-Z0-9_]*`                      |
| `api-domains`          | header injection domains    | required with `api-headers`                        |
| `api-headers`          | literal/env-backed headers  | values may use declared `${NAME}`                  |
| `credentials`          | token delivery              | `oauth-bearer` or `github-app`                     |
| `oauth`                | user OAuth                  | requires `credentials.type: oauth-bearer`          |
| `target`               | target/config metadata      | `config-key` must be in `config-keys`              |
| `runtime-dependencies` | sandbox packages            | `npm` or `system`                                  |
| `runtime-postinstall`  | setup commands              | `cmd`, optional `args`, optional `sudo`            |
| `mcp`                  | hosted HTTP MCP             | HTTPS `url`, optional `allowed-tools`              |

## OAuth bearer

```yaml
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
```

## GitHub App

```yaml
credentials:
  type: github-app
  api-domains:
    - api.github.com
  auth-token-env: GITHUB_TOKEN
  auth-token-placeholder: ghp_host_managed_credential
  app-id-env: GITHUB_APP_ID
  private-key-env: GITHUB_APP_PRIVATE_KEY
  installation-id-env: GITHUB_INSTALLATION_ID
```

## MCP + headers

```yaml
env-vars:
  EXAMPLE_SITE:
    default: example.com
  EXAMPLE_AUTH_HEADER:

api-domains:
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

- `api-headers` requires `api-domains`.
- `api-domains` requires `api-headers`.
- `oauth` requires `credentials.type: oauth-bearer`.
- `mcp.url` env refs must be declared in `env-vars`.
- API-header env refs must not declare defaults.
- `Authorization` is reserved inside token-backed `credentials.api-headers`.
- `target.config-key` must be listed in `config-keys`.
- System dependencies must not declare `version`.
- System URL dependencies require HTTPS `url` plus 64-char hex `sha256`.
