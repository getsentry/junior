# Plugin Runtime Spec

## Metadata

- Created: 2026-05-28
- Last Edited: 2026-05-28

## Purpose

Define how plugin manifests, skills, credentials, and MCP tool catalogs are loaded and exposed at runtime.

## Scope

- Plugin discovery and registration.
- Capability catalog and broker integration.
- MCP activation.
- Plugin-backed skill loading.
- Security invariants for host-trusted plugin content.

## Non-Goals

- Manifest field syntax; see [Plugin Manifest Spec](./plugin-manifest.md).
- Provider credential issuance; see [Credential Injection Spec](./credential-injection.md).
- Trusted heartbeat/dispatch hooks; see [Trusted Plugin Heartbeat Spec](./trusted-plugin-heartbeat.md).

## Discovery And Loading

1. Scan local plugin roots under `plugins/`.
2. Scan explicitly declared package roots from `PluginConfig`.
3. Apply `PluginConfig` manifest overrides.
4. Parse and validate every effective manifest before registering any plugin.
5. Register capabilities, config keys, OAuth config, provider domains, and skill roots.
6. Discover plugin skills later through `getPluginSkillRoots()`.

Plugin registry initialization is synchronous at module load so `discoverSkills()` can associate plugin-backed skills with their parent plugin.

Plugin packages must be explicitly declared in app `PluginConfig`. Runtime must never scan `node_modules`, `package.json` dependencies, or arbitrary filesystem paths to auto-discover plugins.

## Registry Surface

```ts
getPluginCapabilityProviders(): CapabilityProviderDefinition[]
getPluginProviders(): PluginDefinition[]
getPluginOAuthConfig(provider): OAuthProviderConfig | undefined
getPluginSkillRoots(): string[]
isPluginProvider(provider): boolean
isPluginCapability(capability): boolean
isPluginConfigKey(key): boolean
createPluginBroker(provider, deps: PluginBrokerDeps): CredentialBroker
```

## Broker Creation

`createPluginBroker(provider, deps)` constructs brokers from manifest config:

- `oauth-bearer`: generic OAuth bearer broker for per-user OAuth tokens, refresh, static fallback outside requester-bound turns, command env, and header transforms.
- `github-app`: GitHub App broker that signs JWTs and exchanges them for short-lived installation tokens.
- plugin-level `api-headers`: API header broker for providers that need header injection without OAuth/App credentials.
- no credentials/no headers: provider-scoped no-credentials error when authenticated work needs that provider.

Tests and evals seed credentials through the same stores and plugin env vars used by production paths. Broker selection must not switch to test-only credential behavior.

## Capability Catalog

`catalog.ts` sources capabilities from plugins:

```ts
const CAPABILITY_PROVIDERS = [...getPluginCapabilityProviders()];
```

Existing helpers such as `getCapabilityProvider` and `isKnownCapability` work through plugin-sourced providers.

Install-wide config defaults use `createApp({ configDefaults })` and must reference registered plugin config keys. Channel-scoped overrides take precedence over install-wide defaults.

## MCP Activation

- MCP tools are not sandbox dependencies and are not registered globally at startup.
- Runtime activates a plugin's MCP tools only after a skill owned by that plugin is loaded in the current turn.
- Explicit `/skill` invocations preload the skill first.
- Remote MCP catalogs are authoritative only after connection and `listTools`.
- Mid-turn `loadSkill` updates the host-managed MCP registry, but Junior does not mutate the Pi native tool list during the turn.
- Stable native tools `searchMcpTools` and `callMcpTool` search and execute active-provider MCP tools.
- `loadSkill` returns provider/count metadata, not full tool descriptors.
- `searchMcpTools` returns focused descriptors including canonical `tool_name`, upstream `mcp_tool_name`, schemas, and annotations.
- Preloaded and resumed skills disclose provider/count summaries in `<active-mcp-catalogs>`.
- MCP OAuth uses `/api/oauth/callback/mcp/<plugin>` and resumes the paused turn after authorization.
- Canonical MCP tool names remain `mcp__<plugin>__<tool>`.

## Plugin Skills

Plugin skills use the normal `SKILL.md` format and frontmatter contract.

When runtime loads a plugin-backed skill, it must:

1. Re-resolve the parent plugin from the skill path.
2. Reject stale or forged metadata that names a different plugin.
3. Rebuild loaded metadata from current `SKILL.md` frontmatter.
4. Prepend a host-owned runtime boundary derived from `plugin.yaml`.

Plugin-backed skills may explain provider commands, MCP tools, command env, config defaults, and provider-specific query syntax. They must not ask the model to install packages, run installers, configure API keys, configure OAuth, configure tokens, configure MCP endpoints, or repair sandbox package installation.

## Trusted App Plugins

Trusted agent behavior is initialized from app code, not `plugin.yaml`.

Apps pass trusted plugin factories to `createApp({ plugins })`, and `juniorNitro({ plugins })` owns build-time copying of bundled plugin content.

Hook contexts expose narrow capabilities rather than raw Junior internals. Trusted plugin hook contracts are defined in [Trusted Plugin Heartbeat Spec](./trusted-plugin-heartbeat.md) and [Trusted Plugin Dispatch Spec](./trusted-plugin-dispatch.md).

## Security Properties

- Plugin manifests are committed YAML files, not dynamically loaded remote code.
- Credential delivery uses host-managed headers and requester-bound leases.
- Real secret values never enter sandbox env vars, files, command args, skill text, or model-visible tool args.
- Plugin manifests are parsed once at startup and are not mutated at runtime.
- Plugin prompt behavior must be local to the loaded skill or trusted tool guidance.

## Observability

- Plugin broker creation annotates active spans with `app.plugin.name`, `app.plugin.capabilities`, and `app.plugin.has_oauth`.
- `capability_catalog_loaded` includes plugin-sourced capabilities.

## Verification

- Package discovery is empty when no package names are configured.
- Registry load order is deterministic.
- Manifest validation fails before partial registration.
- Plugin-backed skill loading rejects forged plugin metadata.
- MCP tools activate only after same-plugin skill load.
- `searchMcpTools` and `callMcpTool` cannot reach inactive provider tools.

## Related Specs

- `./plugin.md`
- `./plugin-manifest.md`
- `./credential-injection.md`
- `./agent-prompt.md`
- `./trusted-plugin-heartbeat.md`
- `./trusted-plugin-dispatch.md`
