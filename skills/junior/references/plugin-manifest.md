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

| Field                  | Purpose                     | Rules                                                                                             |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `config-keys`          | defaults/targets            | short tokens, qualified as `<plugin>.<key>`                                                       |
| `env-vars`             | allowed deployment env refs | keys match `[A-Z_][A-Z0-9_]*`                                                                     |
| `domains`              | header injection domains    | required with `api-headers`                                                                       |
| `api-headers`          | literal/env-backed headers  | values may use declared `${NAME}`                                                                 |
| `credentials`          | token delivery              | `oauth-bearer` in `plugin.yaml`; code plugins can own egress credentials with hooks               |
| `oauth`                | user OAuth                  | requires `credentials.type: oauth-bearer` in `plugin.yaml`                                        |
| `target`               | target/config metadata      | `config-key` must be in `config-keys`                                                             |
| `runtime-dependencies` | sandbox packages            | `npm` or `system`                                                                                 |
| `runtime-postinstall`  | setup commands              | `cmd`, optional `args`, optional `sudo`                                                           |
| `mcp`                  | hosted HTTP MCP             | HTTPS `url`; omit `allowed-tools` by default; optional `wrapped-tools`, `auth`, or `oauth-client` |

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

## MCP bot auth

Use `mcp.auth` when the MCP server trusts Junior as a bot, not each user.

```yaml
mcp:
  url: https://mcp.example.com/mcp
  auth:
    issuer: https://junior.example.com
    key-id: junior-1
    private-key-env: EXAMPLE_MCP_PRIVATE_KEY
```

- Junior signs a short-lived RS256 assertion, with the plugin `name` as subject
  and the server issuer as audience, then exchanges it with the ID-JAG profile
  of the RFC 7523 `jwt-bearer` grant. Users get no OAuth link.
- `private-key-env` holds a PKCS#8 PEM key with real newlines. The server must
  trust `issuer` and must get the public key for `key-id` from a JWKS URL that
  you publish.

## MCP pre-registered OAuth client

Use `mcp.oauth-client` when the MCP authorization server does not support
dynamic client registration. Each user still authorizes with OAuth.

```yaml
env-vars:
  EXAMPLE_MCP_CLIENT_ID:
  EXAMPLE_MCP_CLIENT_SECRET:

mcp:
  url: https://mcp.example.com/mcp
  oauth-client:
    client-id-env: EXAMPLE_MCP_CLIENT_ID
    client-secret-env: EXAMPLE_MCP_CLIENT_SECRET
    scope: example.readonly
    authorize-params:
      access_type: offline
```

- Register the client with the redirect URI
  `<JUNIOR_BASE_URL>/api/oauth/callback/mcp/<plugin-name>`.
- `scope` replaces the scopes that the MCP server advertises. Use it to keep a
  plugin read-only.
- `authorize-params` adds provider-specific parameters to the authorization
  URL. `client_id`, `scope`, `state`, `redirect_uri`, and `response_type` are
  reserved.

## Accounts and service account

Use top-level `accounts` to say which accounts Junior may use. Per-user OAuth
stays the default, and the actor's own connection always wins.

```yaml
mcp:
  url: https://mcp.example.com/mcp
  allowed-tools:
    - search
    - fetch
    - create-page

accounts:
  service-account: # omit for no service account
    tools:
      - search
      - fetch
  # user-oauth: false   # use only the service account
```

- The service account has no effect until an admin connects it on the
  dashboard Admin page, or runs `junior service-account connect <plugin-name>`.
- `service-account.tools` lists the MCP tools that the shared account may
  call. List only what everyone who can talk to Junior may do, usually read
  tools. An actor without their own connection uses the service account for
  these tools. Other tools still use the actor's own OAuth.
- `user-oauth: false` turns off the actor's own OAuth for the plugin. Junior
  then hides every tool that `service-account.tools` does not list. The
  default is `true`.

## Parser traps

- `api-headers` requires `domains`.
- `domains` requires `api-headers` in `plugin.yaml`.
- `oauth` requires `credentials.type: oauth-bearer` in `plugin.yaml`.
- `mcp.url` env refs must be declared in `env-vars`.
- `mcp.headers` env refs must be declared in `env-vars` and must not declare
  defaults. Junior resolves them when it connects, so build output keeps only
  the placeholder.
- API-header env refs must not declare defaults.
- `command-env` env refs must not reuse API-header, MCP header, credential,
  OAuth, `mcp.auth.private-key-env`, or `mcp.oauth-client` env vars.
- `mcp.oauth-client` env vars must be declared in `env-vars` and must not
  declare defaults.
- `mcp` must not declare both `auth` and `oauth-client`.
- `accounts.service-account.tools` entries must be in `mcp.allowed-tools` or
  `mcp.wrapped-tools` when `allowed-tools` is set.
- `accounts.service-account` must not be combined with `mcp.auth` or
  `mcp.oauth-client`, and needs an `mcp` block.
- `accounts.user-oauth: false` requires `accounts.service-account`.
- `accounts` rejects unknown keys.
- `Authorization` is reserved inside `oauth-bearer` `credentials.api-headers`.
- `target.config-key` must be listed in `config-keys`.
- System dependencies must not declare `version`.
- System URL dependencies require HTTPS `url` plus 64-char hex `sha256`.
