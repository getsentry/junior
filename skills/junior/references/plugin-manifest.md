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
| `config-keys`          | defaults/targets            | short tokens, qualified as `<plugin>.<key>`                                         |
| `env-vars`             | allowed deployment env refs | keys match `[A-Z_][A-Z0-9_]*`                                                       |
| `domains`              | header injection domains    | required with `api-headers`                                                         |
| `api-headers`          | literal/env-backed headers  | values may use declared `${NAME}`                                                   |
| `credentials`          | token delivery              | `oauth-bearer` in `plugin.yaml`; code plugins can own egress credentials with hooks |
| `oauth`                | user OAuth                  | requires `credentials.type: oauth-bearer` in `plugin.yaml`                          |
| `target`               | target/config metadata      | `config-key` must be in `config-keys`                                               |
| `runtime-dependencies` | sandbox packages            | `npm` or `system`                                                                   |
| `runtime-postinstall`  | setup commands              | `cmd`, optional `args`, optional `sudo`                                             |
| `mcp`                  | hosted HTTP MCP             | HTTPS `url`; omit `allowed-tools` by default; optional `wrapped-tools`              |

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
```

Omit `allowed-tools` unless the plugin must hide part of the provider surface.
When set, only listed tools are exposed and discovery fails if any are missing.

### MCP wrapper tools

Code plugins can replace selected provider tools with plugin-owned tools:

```ts
mcp: {
  transport: "http",
  url: "https://mcp.example.com/mcp",
  allowedTools: ["search", "fetch"],
  wrappedTools: ["create_item"],
}
```

- `allowedTools` lists provider tools exposed directly to the model.
- `wrappedTools` lists provider tools hidden from the model and callable only
  through that plugin's `ctx.mcp` capability.
- Register the replacement as a normal plugin tool from `hooks.tools`.
- The host loads the union of both lists, so wrapped tools do not need to be
  repeated in `allowedTools`.
- `callTool` activates the provider when needed. Durable mutation wrappers can
  call `prepare` first so an initial authorization pause happens before they
  persist pending work.
- Successful calls contain the provider's original `content` and optional
  `structuredContent`. Definitive provider rejections return `status: "error"`;
  authorization pauses contain no provider content; transport failures throw.
- Durable mutation wrappers must clear pending idempotency state for
  `authorization_pending` and `error` results, but retain it after a thrown
  transport failure whose provider outcome is uncertain. See
  `packages/junior-github/src/tools/create-issue.ts` for an example.
- Prefer `afterMcpTool` when the only junior-owned work is a post-success side
  effect such as conversation annotations. Keep `wrappedTools` for cases that
  need a different product verb, idempotency, or a non-provider contract.

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
