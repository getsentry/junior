# Plugin Architecture Spec

## Status

Implemented (Sentry + GitHub migrated)

## Related

- [Skill Capabilities Spec](./skill-capabilities-spec.md)
- [OAuth Flows Spec](./oauth-flows.md)
- [Security Policy](./security-policy.md)
- Plugin Registry: `src/chat/plugins/registry.ts`
- Plugin Types: `src/chat/plugins/types.ts`
- Generic OAuth Bearer Broker: `src/chat/plugins/oauth-bearer-broker.ts`
- GitHub App Broker: `src/chat/plugins/github-app-broker.ts`
- Provider Catalog: `src/chat/capabilities/catalog.ts`
- Broker Factory: `src/chat/capabilities/factory.ts`
- OAuth Providers: `src/chat/capabilities/jr-rpc-command.ts`

## Purpose

Define a plugin model where provider integrations are self-contained directories that bundle capabilities, credentials, and skills — so that adding a new provider requires zero changes to core runtime files.

## Core model

1. A plugin is a directory under `src/plugins/<name>/` containing a `plugin.yaml` manifest.
2. At startup, the plugin registry scans `src/plugins/` and parses each manifest synchronously (`readFileSync`).
3. The registry registers capabilities, config keys, OAuth config, and skill roots from each manifest.
4. Credential brokers are created on demand from manifest config (`oauth-bearer` or `github-app` type).
5. Skills in `src/plugins/<name>/skills/` are auto-discovered alongside existing skill roots.
6. Core infrastructure (agent loop, sandbox, jr-rpc, Slack tools, web tools) stays unchanged.

## Plugin directory structure

```
src/plugins/sentry/
├── plugin.yaml           # manifest (required)
└── skills/
    └── sentry/
        └── SKILL.md      # standard skill format
```

## Plugin manifest format

```yaml
# plugin.yaml — annotated example
name: sentry                         # unique plugin identifier
description: Sentry issue tracking   # human-readable summary

capabilities:                        # short names — qualified to sentry.api
  - api

config-keys:                         # short names — qualified to sentry.org, etc.
  - org
  - project

credentials:                         # how tokens are delivered to the sandbox
  type: oauth-bearer                 # bearer token via Authorization header
  api-domains:                       # domains for header transforms
    - sentry.io
    - us.sentry.io
    - de.sentry.io
  auth-token-env: SENTRY_AUTH_TOKEN  # env var for static fallback + sandbox placeholder

oauth:                               # optional — omit for non-OAuth providers
  client-id-env: SENTRY_CLIENT_ID
  client-secret-env: SENTRY_CLIENT_SECRET
  authorize-endpoint: https://sentry.io/oauth/authorize/
  token-endpoint: https://sentry.io/oauth/token/
  scope: "event:read org:read project:read"

target:                              # optional — omit for org-scoped providers
  type: repo
  config-key: sentry.project

mcp:                                 # optional — MCP server config for tool sources
  command: npx
  args: ["-y", "@sentry/mcp-server"]
  env:
    SENTRY_AUTH_TOKEN: "${SENTRY_AUTH_TOKEN}"
```

## Plugin manifest contract

### Required fields

| Field | Type | Rules |
|-------|------|-------|
| `name` | `string` | Must match `^[a-z][a-z0-9-]*$`. Unique across all plugins. |
| `description` | `string` | Non-empty. |
| `capabilities` | `string[]` | Short names (e.g. `issues.read`). Qualified to `<name>.issues.read` by the registry. At least one required. No qualified capability may appear in more than one plugin. |
| `config-keys` | `string[]` | Short names (e.g. `org`). Qualified to `<name>.org` by the registry. |
| `credentials` | `object` | Credential delivery configuration. |
| `credentials.type` | `string` | `"oauth-bearer"` or `"github-app"`. |
| `credentials.api-domains` | `string[]` | Domains for `Authorization: Bearer` header transforms. At least one required. |
| `credentials.auth-token-env` | `string` | Env var name for static token fallback and sandbox placeholder. |

### Optional fields

| Field | Type | Rules |
|-------|------|-------|
| `credentials.app-id-env` | `string` | Env var name for GitHub App ID. Required when `credentials.type` is `"github-app"`. |
| `credentials.private-key-env` | `string` | Env var name for GitHub App private key (PEM). Required when `credentials.type` is `"github-app"`. |
| `credentials.installation-id-env` | `string` | Env var name for GitHub App installation ID. Required when `credentials.type` is `"github-app"`. |
| `oauth` | `object` | OAuth provider configuration. All sub-fields required when present. |
| `oauth.client-id-env` | `string` | Env var name for client ID. |
| `oauth.client-secret-env` | `string` | Env var name for client secret. |
| `oauth.authorize-endpoint` | `string` | Valid HTTPS URL. |
| `oauth.token-endpoint` | `string` | Valid HTTPS URL. |
| `oauth.scope` | `string` | OAuth scope string. |
| `target` | `object` | Capability target for scoped credentials. |
| `target.type` | `string` | Currently only `"repo"`. |
| `target.config-key` | `string` | Must appear in `config-keys`. |
| `mcp` | `object` | MCP server configuration for external tool sources. Reserved — not yet parsed by the registry. |

### Derived values

| Value | Derivation |
|-------|-----------|
| OAuth callback path | `/api/oauth/callback/<name>` — derived from plugin name. |
| Skill roots | `src/plugins/<name>/skills/` — auto-discovered. |
| Qualified capabilities | `<name>.<capability>` — short names prefixed with plugin name. |
| Qualified config keys | `<name>.<key>` — short names prefixed with plugin name. |

### Validation

- Parse all manifests before registering any plugin. Fail startup on validation errors.
- No two plugins may declare the same capability token.
- No two plugins may use the same `name`.
- If `target.config-key` is set, it must be listed in `config-keys`.

## Discovery and loading

### Two-phase initialization

**Sync phase** (module load): Read `plugin.yaml` manifests via `readFileSync`, register capabilities, config keys, OAuth config, and skill roots. This keeps `catalog.ts` sync-compatible.

**On-demand phase**: Create credential brokers when `factory.ts` constructs the runtime. The generic `oauth-bearer` broker is created from manifest config — no dynamic imports needed.

### Load sequence

1. **Scan** `src/plugins/` for directories containing `plugin.yaml`.
2. **Parse** each manifest and validate against the contract above.
3. **Register** capabilities, config keys, OAuth config in internal maps.
4. **Annotate** active span with plugin metadata per broker creation.
5. Plugin skills are discovered later by `discoverSkills()` via `getPluginSkillRoots()`.

### Initialization ordering

The plugin registry is initialized at module load time (sync). This means it is fully populated before the first call to `discoverSkills()`, ensuring `isKnownCapability()` and `isKnownConfigKey()` validate plugin-contributed skills correctly.

### Credential broker creation

The registry provides `createPluginBroker(provider, deps)` which constructs the appropriate broker from manifest config:

- `oauth-bearer`: Creates a generic `OAuthBearerBroker` that handles per-user OAuth tokens, token refresh, static env fallback, and header transforms — all parameterized from the manifest.
- `github-app`: Creates a `GitHubAppBroker` that signs JWTs with an RSA private key and exchanges them for short-lived installation tokens via the GitHub App API. No `UserTokenStore` dependency — tokens are per-installation, not per-user.

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

## Capability and credential integration

### Catalog integration

`catalog.ts` sources all capabilities from plugins:

```typescript
const CAPABILITY_PROVIDERS = [
  ...getPluginCapabilityProviders()
];
```

All existing functions (`getCapabilityProvider`, `isKnownCapability`, etc.) work transparently.

### Broker creation

`factory.ts` creates plugin brokers generically:

```typescript
for (const plugin of getPluginProviders()) {
  const { credentials, name } = plugin.manifest;
  brokersByProvider[name] = useTestBroker
    ? new TestCredentialBroker({ provider: name, domains: credentials.apiDomains, envKey: credentials.authTokenEnv, placeholder: "host_managed_credential" })
    : createPluginBroker(name, { userTokenStore });
}
```

### OAuth provider integration

`jr-rpc-command.ts` checks plugin OAuth config via `getOAuthProviderConfig()`:

```typescript
export function getOAuthProviderConfig(provider: string): OAuthProviderConfig | undefined {
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
  const envRoots = process.env.SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? [];
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

| Component | Reason |
|-----------|--------|
| Agent loop (`ToolLoopAgent`, harness) | Core orchestration, not provider-specific |
| Sandbox and container isolation | Security boundary, shared by all providers |
| `jr-rpc` command infrastructure | Generic RPC layer — reads config from registry |
| Slack tools (canvas, list, channel, message) | Platform tools, not provider integrations |
| Web tools (search, fetch) | General-purpose, not provider-specific |
| Skill infrastructure (discovery, frontmatter, loading) | Framework — plugins contribute skills |
| `CredentialBroker` interface and `CredentialLease` type | Shared contract |
| `ProviderCredentialRouter` | Generic router |
| `SkillCapabilityRuntime` | Generic runtime |
| OAuth callback route (`/api/oauth/callback/[provider]`) | Shared HTTP handler |
| `TestCredentialBroker` | Eval infrastructure, not a plugin |

## Example: adding a new provider (Linear)

1. Create `src/plugins/linear/plugin.yaml`:

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

2. Create `src/plugins/linear/skills/linear/SKILL.md`

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
