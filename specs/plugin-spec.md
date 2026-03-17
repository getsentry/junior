# Plugin Architecture Spec

## Metadata

- Created: 2026-03-01
- Last Edited: 2026-03-13

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated code and test file references to repo-root paths under `packages/junior/`.
- 2026-03-06: Added runtime dependency declarations and linked sandbox snapshot lifecycle contract.
- 2026-03-06: Made plugin credentials/capabilities/config-keys optional to support bundle-only plugins.
- 2026-03-09: Added OAuth request overrides, optional OAuth scope, and plugin-level API headers.
- 2026-03-13: Implemented HTTP MCP manifests, same-plugin progressive tool activation, and dedicated MCP OAuth callbacks.

## Status

Implemented (Sentry + GitHub migrated)

## Related

- [Skill Capabilities Spec](./skill-capabilities-spec.md)
- [OAuth Flows Spec](./oauth-flows-spec.md)
- [Security Policy](./security-policy.md)
- [Sandbox Snapshots Spec](./sandbox-snapshots-spec.md)
- Plugin Registry: `packages/junior/src/chat/plugins/registry.ts`
- Plugin Types: `packages/junior/src/chat/plugins/types.ts`
- Generic OAuth Bearer Broker: `packages/junior/src/chat/plugins/oauth-bearer-broker.ts`
- GitHub App Broker: `packages/junior/src/chat/plugins/github-app-broker.ts`
- Provider Catalog: `packages/junior/src/chat/capabilities/catalog.ts`
- Broker Factory: `packages/junior/src/chat/capabilities/factory.ts`
- OAuth Providers: `packages/junior/src/chat/capabilities/jr-rpc-command.ts`

## Purpose

Define a plugin model where provider integrations are self-contained directories that bundle optional capabilities, optional credentials, and skills — so that adding a new provider requires zero changes to core runtime files.

## Core model

1. A plugin is either:
   - a directory under `plugins/<name>/` containing a `plugin.yaml` manifest, or
   - an installed npm dependency that contains plugin content in `plugin.yaml` or `plugins/`.
2. At startup, the plugin registry scans local plugin roots and packaged plugin roots, then parses each manifest synchronously (`readFileSync`).
3. The registry registers capabilities, config keys, OAuth config, and skill roots from each manifest.
4. Credential brokers are created on demand only for plugins that declare credentials (`oauth-bearer` or `github-app` type).
5. Skills in `plugins/<name>/skills/` are auto-discovered alongside existing skill roots.
6. Plugin-declared MCP tools are host-managed and activated only after a skill from the same plugin is loaded for the turn.
7. Core infrastructure (agent loop, sandbox, jr-rpc, Slack tools, web tools) stays unchanged outside the MCP activation/resume wiring.

## Plugin directory structure

```
plugins/sentry/
├── plugin.yaml           # manifest (required)
└── skills/
    └── sentry/
        └── SKILL.md      # standard skill format
```

## Plugin manifest format

```yaml
# plugin.yaml — bundle-only example
name: sentry # unique plugin identifier
description: Sentry helper workflows # human-readable summary
```

```yaml
# plugin.yaml — credentialed provider example
name: sentry # unique plugin identifier
description: Sentry issue tracking # human-readable summary

capabilities: # short names — qualified to sentry.api
  - api

config-keys: # short names — qualified to sentry.org, etc.
  - org
  - project

credentials: # how tokens are delivered to the sandbox
  type: oauth-bearer # bearer token via Authorization header
  api-domains: # domains for header transforms
    - sentry.io
    - us.sentry.io
    - de.sentry.io
  api-headers: # optional headers applied alongside Authorization
    X-Api-Version: 2026-01-01
  auth-token-env: SENTRY_AUTH_TOKEN # env var for static fallback + sandbox placeholder
  auth-token-placeholder: host_managed_credential # optional placeholder value for CLI env checks

oauth: # optional — omit for non-OAuth providers
  client-id-env: SENTRY_CLIENT_ID
  client-secret-env: SENTRY_CLIENT_SECRET
  authorize-endpoint: https://sentry.io/oauth/authorize/
  token-endpoint: https://sentry.io/oauth/token/
  scope: "event:read org:read project:read" # optional
  authorize-params: # optional extra authorize query params
    audience: workspace
  token-auth-method: basic # optional; default body
  token-extra-headers: # optional token request headers
    Content-Type: application/json

target: # optional — omit for org-scoped providers
  type: repo
  config-key: sentry.project

runtime-dependencies: # optional — preinstalled CLI dependencies for sandbox snapshots
  - type: npm
    package: sentry
    # version omitted => latest
  - type: system
    package: gh
  - type: system
    url: https://example.com/tool.rpm
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

runtime-postinstall: # optional — post-install commands executed before snapshot capture
  - cmd: example-cli
    args: ["install"]

mcp: # optional — MCP server config for tool sources
  transport: http
  url: https://mcp.example.com/mcp
  headers:
    X-Workspace: acme
```

## Plugin manifest contract

### Required fields

| Field         | Type     | Rules                                                      |
| ------------- | -------- | ---------------------------------------------------------- |
| `name`        | `string` | Must match `^[a-z][a-z0-9-]*$`. Unique across all plugins. |
| `description` | `string` | Non-empty.                                                 |

### Optional fields

| Field                                | Type                     | Rules                                                                                                                                            |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capabilities`                       | `string[]`               | Short names (e.g. `issues.read`). Qualified to `<name>.issues.read` by the registry. No qualified capability may appear in more than one plugin. |
| `config-keys`                        | `string[]`               | Short names (e.g. `org`). Qualified to `<name>.org` by the registry.                                                                             |
| `credentials`                        | `object`                 | Credential delivery configuration.                                                                                                               |
| `credentials.type`                   | `string`                 | `"oauth-bearer"` or `"github-app"`.                                                                                                              |
| `credentials.api-domains`            | `string[]`               | Domains for `Authorization: Bearer` header transforms. At least one required.                                                                    |
| `credentials.api-headers`            | `Record<string, string>` | Optional headers applied to matching API domains alongside `Authorization`. `Authorization` itself is reserved.                                  |
| `credentials.auth-token-env`         | `string`                 | Env var name for static token fallback and sandbox placeholder.                                                                                  |
| `credentials.auth-token-placeholder` | `string`                 | Optional non-secret placeholder injected into sandbox env for CLI compatibility.                                                                 |
| `credentials.app-id-env`             | `string`                 | Env var name for GitHub App ID. Required when `credentials.type` is `"github-app"`.                                                              |
| `credentials.private-key-env`        | `string`                 | Env var name for GitHub App private key (PEM). Required when `credentials.type` is `"github-app"`.                                               |
| `credentials.installation-id-env`    | `string`                 | Env var name for GitHub App installation ID. Required when `credentials.type` is `"github-app"`.                                                 |
| `oauth`                              | `object`                 | OAuth provider configuration. Requires `credentials.type` = `"oauth-bearer"`.                                                                    |
| `oauth.client-id-env`                | `string`                 | Env var name for client ID.                                                                                                                      |
| `oauth.client-secret-env`            | `string`                 | Env var name for client secret.                                                                                                                  |
| `oauth.authorize-endpoint`           | `string`                 | Valid HTTPS URL.                                                                                                                                 |
| `oauth.token-endpoint`               | `string`                 | Valid HTTPS URL.                                                                                                                                 |
| `oauth.scope`                        | `string`                 | Optional OAuth scope string.                                                                                                                     |
| `oauth.authorize-params`             | `Record<string, string>` | Optional authorize URL params added alongside core params. Reserved OAuth param names may not be overridden.                                     |
| `oauth.token-auth-method`            | `string`                 | Optional token client auth method: `"body"` (default) or `"basic"`.                                                                              |
| `oauth.token-extra-headers`          | `Record<string, string>` | Optional token request headers. `Authorization` is reserved; `Content-Type` controls token body serialization.                                   |
| `target`                             | `object`                 | Capability target for scoped credentials.                                                                                                        |
| `target.type`                        | `string`                 | Currently only `"repo"`.                                                                                                                         |
| `target.config-key`                  | `string`                 | Must appear in `config-keys`.                                                                                                                    |
| `runtime-dependencies`               | `object[]`               | Optional sandbox dependency declarations used to build reusable snapshots.                                                                       |
| `runtime-dependencies[].type`        | `string`                 | `"npm"` or `"system"`.                                                                                                                           |
| `runtime-dependencies[].package`     | `string`                 | Package identifier (npm package name or system package name). Required for `npm`; optional for `system` when `url` is used.                      |
| `runtime-dependencies[].version`     | `string`                 | Optional for `npm` dependencies. When omitted, runtime uses `latest`. Must be omitted for `system` dependencies.                                 |
| `runtime-dependencies[].url`         | `string`                 | HTTPS URL for direct system package install (RPM). Allowed only for `system` dependencies.                                                       |
| `runtime-dependencies[].sha256`      | `string`                 | Required with `url`. Lowercase or uppercase hex SHA-256 checksum used for integrity verification before install.                                 |
| `runtime-postinstall`                | `object[]`               | Optional post-install command declarations executed after dependency install and before snapshot capture.                                        |
| `runtime-postinstall[].cmd`          | `string`                 | Non-empty command name.                                                                                                                          |
| `runtime-postinstall[].args`         | `string[]`               | Optional command arguments.                                                                                                                      |
| `runtime-postinstall[].sudo`         | `boolean`                | Optional sudo flag for commands requiring elevated privileges.                                                                                   |
| `mcp`                                | `object`                 | Optional MCP server configuration for host-managed tool discovery.                                                                               |
| `mcp.transport`                      | `string`                 | Must be `"http"` in v1. Stdio/command transports are not supported.                                                                              |
| `mcp.url`                            | `string`                 | HTTPS endpoint for the MCP server.                                                                                                               |
| `mcp.headers`                        | `Record<string, string>` | Optional static non-Authorization headers sent with MCP HTTP requests. `Authorization` is reserved for runtime-managed auth.                     |

Snapshot build/reuse and invalidation behavior for `runtime-dependencies` is defined in [Sandbox Snapshots Spec](./sandbox-snapshots-spec.md).

System runtime dependency execution environment:

- Sandbox OS is Amazon Linux 2023.
- System installs run via `dnf`.
- Install commands must run with root privileges (`sudo: true` at sandbox command execution).
- `system` URL dependencies are downloaded with `curl`, verified with `sha256sum`, then installed via `dnf install -y <local-rpm>`.
- `runtime-postinstall` commands execute after dependency installation and before snapshot capture.

### Derived values

| Value                     | Derivation                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OAuth callback path       | `/api/oauth/callback/<name>` — derived from plugin name.                                                                |
| Skill roots               | `plugins/<name>/skills/` and installed package `skills/` roots — auto-discovered.                                       |
| Qualified capabilities    | `<name>.<capability>` — short names prefixed with plugin name.                                                          |
| Qualified config keys     | `<name>.<key>` — short names prefixed with plugin name.                                                                 |
| Token request body format | Derived automatically from the effective token request `Content-Type`; defaults to `application/x-www-form-urlencoded`. |

### Validation

- Parse all manifests before registering any plugin. Fail startup on validation errors.
- No two plugins may declare the same capability token.
- No two plugins may use the same `name`.
- If `target.config-key` is set, it must be listed in `config-keys`.
- If a plugin declares capabilities without credentials, manifest load succeeds and `jr-rpc issue-credential` fails with an explicit no-credentials error.

## Discovery and loading

### Two-phase initialization

**Sync phase** (module load): Read `plugin.yaml` manifests via `readFileSync`, register capabilities, config keys, OAuth config, and skill roots. This keeps `catalog.ts` sync-compatible.

**On-demand phase**: Create credential brokers when `factory.ts` constructs the runtime for plugins that declare credentials. The generic `oauth-bearer` broker is created from manifest config — no dynamic imports needed.

### Load sequence

1. **Scan local roots** in `plugins/` for directories containing `plugin.yaml`.
2. **Scan package roots** from installed npm dependencies in root `package.json`. A package is considered plugin content when it contains `plugin.yaml`, `plugins/`, or `skills/`.
3. **Parse** each manifest and validate against the contract above.
4. **Register** capabilities, config keys, OAuth config in internal maps.
5. **Annotate** active span with plugin metadata per broker creation.
6. Plugin skills are discovered later by `discoverSkills()` via `getPluginSkillRoots()`.

### Initialization ordering

The plugin registry is initialized at module load time (sync). This means it is fully populated before the first call to `discoverSkills()`, ensuring `isKnownCapability()` and `isKnownConfigKey()` validate plugin-contributed skills correctly.

### Credential broker creation

The registry provides `createPluginBroker(provider, deps)` which constructs the appropriate broker from manifest config:

- `oauth-bearer`: Creates a generic `OAuthBearerBroker` that handles per-user OAuth tokens, token refresh, static env fallback, and header transforms — all parameterized from the manifest.
- `github-app`: Creates a `GitHubAppBroker` that signs JWTs with an RSA private key and exchanges them for short-lived installation tokens via the GitHub App API. No `UserTokenStore` dependency — tokens are per-installation, not per-user.
- no-credentials plugins: broker creation fails with a provider-scoped no-credentials error.

### Plugin registry exports

```typescript
// Sync (available at module load)
getPluginCapabilityProviders(): CapabilityProviderDefinition[]
getPluginProviders(): PluginDefinition[]
getPluginOAuthConfig(provider): OAuthProviderConfig | undefined
getPluginSkillRoots(): string[]
isPluginProvider(provider): boolean
isPluginCapability(capability): boolean
isPluginConfigKey(key): boolean

// On-demand broker creation
createPluginBroker(provider, deps: PluginBrokerDeps): CredentialBroker
```

### MCP tool activation

- MCP tools are not sandbox dependencies and are not registered globally at startup.
- The runtime activates a plugin's MCP tools only after a skill owned by that plugin is loaded in the current turn.
- Explicit `/skill` invocations preload the skill first, so same-plugin MCP tools are available before the first model step.
- Mid-turn `loadSkill` updates the active Pi tool list for subsequent agent steps.
- MCP tool names are exposed to Pi as `mcp__<plugin>__<tool>`.
- MCP authorization uses a dedicated callback path at `/api/oauth/callback/mcp/<plugin>` and resumes the paused turn session after the user authorizes.

## Capability and credential integration

### Catalog integration

`catalog.ts` sources all capabilities from plugins:

```typescript
const CAPABILITY_PROVIDERS = [...getPluginCapabilityProviders()];
```

All existing functions (`getCapabilityProvider`, `isKnownCapability`, etc.) work transparently.

### Broker creation

`factory.ts` creates plugin brokers generically:

```typescript
for (const plugin of getPluginProviders()) {
  const { credentials, name } = plugin.manifest;
  if (!credentials) continue;
  brokersByProvider[name] = useTestBroker
    ? new TestCredentialBroker({
        provider: name,
        domains: credentials.apiDomains,
        envKey: credentials.authTokenEnv,
        placeholder: "host_managed_credential",
      })
    : createPluginBroker(name, { userTokenStore });
}
```

### OAuth provider integration

`jr-rpc-command.ts` checks plugin OAuth config via `getOAuthProviderConfig()`:

```typescript
export function getOAuthProviderConfig(
  provider: string,
): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDERS[provider] ?? getPluginOAuthConfig(provider);
}
```

The OAuth callback route uses `getOAuthProviderConfig()` instead of accessing `OAUTH_PROVIDERS` directly.

### Test credential override

`TestCredentialBroker` substitution in eval mode works the same — `factory.ts` checks `EVAL_ENABLE_TEST_CREDENTIALS=1` and substitutes regardless of source.

## Skill integration

Plugin skills use the same `SKILL.md` format and frontmatter contract as existing skills.

### Discovery

`resolveSkillRoots()` in `skills.ts` appends `getPluginSkillRoots()`:

```typescript
function resolveSkillRoots(): string[] {
  const envRoots =
    process.env.SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? [];
  const defaults = [path.join(process.cwd(), "src", "junior", "skills")];
  const pluginRoots = getPluginSkillRoots();
  return [...envRoots, ...defaults, ...pluginRoots];
}
```

Plugin skills are subject to the same frontmatter validation, `requires-capabilities` checks, and name-deduplication as non-plugin skills.

## Security properties

All existing security invariants from `security-policy.md` are preserved:

- **Host-trusted code.** Plugin manifests are YAML files committed to the repository. No dynamic code loading.
- **Credential delivery via header transforms only.** The generic broker delivers tokens as `Authorization: Bearer` headers on each declared `api-domains` entry. The sandbox never sees real token values.
- **Short-lived leases.** Lease behavior is unchanged. The `CredentialLease` contract enforces expiry timestamps.
- **No env var leakage.** Placeholder values are injected for the `auth-token-env` variable.
- **OAuth privacy rules unchanged.** Authorization URLs are delivered privately. The agent never sees token values.
- **Plugin manifests are static.** Parsed once at startup, no runtime mutation.

## What stays core (not plugins)

| Component                                               | Reason                                         |
| ------------------------------------------------------- | ---------------------------------------------- |
| Agent loop (`Agent` runtime + harness)                  | Core orchestration, not provider-specific      |
| Sandbox and container isolation                         | Security boundary, shared by all providers     |
| `jr-rpc` command infrastructure                         | Generic RPC layer — reads config from registry |
| Slack tools (canvas, list, channel, message)            | Platform tools, not provider integrations      |
| Web tools (search, fetch)                               | General-purpose, not provider-specific         |
| Skill infrastructure (discovery, frontmatter, loading)  | Framework — plugins contribute skills          |
| `CredentialBroker` interface and `CredentialLease` type | Shared contract                                |
| `ProviderCredentialRouter`                              | Generic router                                 |
| `SkillCapabilityRuntime`                                | Generic runtime                                |
| OAuth callback route (`/api/oauth/callback/[provider]`) | Shared HTTP handler                            |
| `TestCredentialBroker`                                  | Eval infrastructure, not a plugin              |

## Example: adding a new provider (Linear)

1. Create `plugins/linear/plugin.yaml`:

```yaml
name: linear
description: Linear issue tracking

capabilities:
  - issues.read
  - issues.write

config-keys:
  - team

credentials:
  type: oauth-bearer
  api-domains:
    - api.linear.app
  auth-token-env: LINEAR_API_KEY

oauth:
  client-id-env: LINEAR_CLIENT_ID
  client-secret-env: LINEAR_CLIENT_SECRET
  authorize-endpoint: https://linear.app/oauth/authorize
  token-endpoint: https://linear.app/api/oauth/token
  scope: "read write"
```

2. Create `plugins/linear/skills/linear/SKILL.md`

3. Register the OAuth app with Linear, set redirect URI to `<base-url>/api/oauth/callback/linear`.

4. Add `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` to environment.

**Core files touched: zero.**

## Observability

- Plugin broker creation annotates active span with: `app.plugin.name`, `app.plugin.capabilities`, `app.plugin.has_oauth`.
- `capability_catalog_loaded` — existing event, now includes plugin-sourced capabilities.

## Non-goals

- **Dynamic plugin loading from untrusted sources.**
- **Plugin marketplace or remote installation.**
- **MCP as the plugin protocol.** MCP is an optional tool source, not the plugin discovery protocol.
- **Plugin sandboxing.** Broker logic runs on the host with full trust.
- **Plugin versioning.** Plugins are part of the monorepo.
- **Custom per-plugin broker modules beyond supported types.** The `oauth-bearer` and `github-app` credential types cover current providers. More types can be added as needed.
