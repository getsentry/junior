# Plugin Runtime Spec

## Metadata

- Created: 2026-05-28
- Last Edited: 2026-06-30

## Purpose

Define how plugin manifests, skills, credentials, and MCP tool catalogs are loaded and exposed at runtime.

## Scope

- Plugin discovery and registration.
- Capability catalog and broker integration.
- MCP activation.
- Plugin-backed skill loading.
- Security invariants for host-executed plugin content.

## Non-Goals

- Manifest field syntax; see [Plugin Manifest Spec](./plugin-manifest.md).
- Provider credential issuance; see [Credential Injection Spec](./credential-injection.md).
- Plugin prompt, background task, database, CLI, heartbeat, dispatch, and
  resource event subscription hooks; see
  [Plugin Prompt Hooks Spec](./plugin-prompt-hooks.md),
  [Plugin Background Tasks Spec](./plugin-tasks.md),
  [Plugin Database Spec](./plugin-database.md),
  [Plugin CLI Spec](./plugin-cli.md),
  [Plugin Heartbeat Spec](./plugin-heartbeat.md), and
  [Plugin Dispatch Spec](./plugin-dispatch.md), and
  [Resource Event Subscriptions Spec](./resource-event-subscriptions.md).

## Discovery And Loading

1. Scan local plugin roots under `plugins/`.
2. Scan manifest package roots declared by the shared `defineJuniorPlugins(...)` catalog.
3. Register inline manifests from JavaScript plugin definitions.
4. Apply `PluginCatalogConfig` manifest overrides derived from that plugin set.
5. Parse and validate every effective manifest before registering any plugin.
6. Register capabilities, config keys, OAuth config, provider domains, and skill roots.
7. Discover plugin skills later through `PluginCatalogRuntime.getSkillRoots()`.

Plugin catalog loading is synchronous when a catalog runtime is read so `discoverSkills()` can associate plugin-backed skills with their parent plugin.

Plugin packages must be explicitly declared by plugin registrations. Runtime must never scan `node_modules`, `package.json` dependencies, or arbitrary filesystem paths to auto-discover plugins.

## Registry Surface

```ts
createPluginCatalogRuntime(): PluginCatalogRuntime

pluginCatalogRuntime.getCapabilityProviders(): CapabilityProviderDefinition[]
pluginCatalogRuntime.getProviders(): PluginDefinition[]
pluginCatalogRuntime.getOAuthConfig(provider): OAuthProviderConfig | undefined
pluginCatalogRuntime.getSkillRoots(): string[]
pluginCatalogRuntime.isProvider(provider): boolean
pluginCatalogRuntime.isCapability(capability): boolean
pluginCatalogRuntime.isConfigKey(key): boolean
pluginCatalogRuntime.createBroker(provider, deps: PluginBrokerDeps): CredentialBroker
```

`createPluginCatalogRuntime()` constructs isolated catalog runtimes for tests and local composition. Runtime app wiring uses the active `pluginCatalogRuntime` instance from `chat/plugins/catalog-runtime`; registry modules must not reintroduce module-level one-method facade exports around that instance.

## Broker Creation

`PluginCatalogRuntime.createBroker(provider, deps)` constructs brokers from generic manifest credential config:

- `oauth-bearer`: generic OAuth bearer broker for per-user OAuth tokens, refresh, static host-token use when no credential context exists, command env, and header transforms.
- plugin-level `api-headers`: API header broker for providers that need header injection without OAuth/App credentials.
- no credentials/no headers: provider-scoped no-credentials error when authenticated work needs that provider.

Plugins with egress credential hooks do not have a generic broker. They declare top-level manifest `domains`, then `grantForEgress` selects plugin-defined grants and `issueCredential` issues short-lived credential leases for those grants. `issueCredential` returns `needed` when user authorization can satisfy the grant, and `unavailable` when plugin setup or runtime state prevents issuing it. A plugin OAuth hook may also resolve provider account metadata after OAuth so stored tokens and permission-denied signals can identify the connected account. App startup fails if egress credential hooks are incomplete, if they are mixed with generic `credentials` or `api-headers`, if the plugin declares egress-only domains without hooks, or if a code manifest declares `oauth` without OAuth bearer credentials and without egress credential hooks.

`grantForEgress` may throw `EgressPolicyDenied` to reject a provider request before credentials are issued. Core maps this denial to HTTP 403 with no auth-required signal and no upstream request; plugins must use this only for deterministic host-owned policy blocks, not missing authorization.

Tests and evals seed credentials through the same stores and plugin env vars used by production paths. Broker selection must not switch to test-only credential behavior.

## Capability Catalog

`catalog.ts` sources capabilities from plugins:

```ts
const CAPABILITY_PROVIDERS = [...pluginCatalogRuntime.getCapabilityProviders()];
```

Existing helpers such as `getCapabilityProvider` and `isKnownCapability` work through plugin-sourced providers.

Install-wide config defaults use `createApp({ configDefaults })` and must reference registered plugin config keys. Channel-scoped overrides take precedence over install-wide defaults.

## MCP Activation

- MCP tools are not sandbox dependencies and are not registered globally at startup.
- At agent-run setup, the runtime restores providers from durable session-log
  `mcp_provider_connected` events. Fresh runs discover providers through
  `searchMcpTools` and connect lazily when the model first accesses one.
- Runtime must infer restored plugin skill and MCP activation state from the
  session log, not side metadata. Successful `loadSkill` tool results identify
  loaded plugin skills. `mcp_provider_connected` events identify connected MCP
  providers.
- Calling `searchMcpTools` without `provider` lists matching configured providers without connecting to them.
- Calling `searchMcpTools({ provider })` or `callMcpTool` for a configured but inactive provider triggers connection and `listTools` on demand, surfacing the auth flow if credentials are missing or expired.
- `loadSkill` does not activate MCP by itself in the target runtime. Skills may
  teach the model how to use provider tools, but provider connection is caused
  by `searchMcpTools({ provider })`, `callMcpTool`, resume restoration, or
  another explicit provider-access path.
- Remote MCP catalogs are authoritative only after connection and `listTools`.
- Mid-run MCP activation updates the host-managed MCP registry, but Junior does not mutate the Pi native tool list during the run.
- `searchMcpTools` and `callMcpTool` search and execute active-provider tools. Both lazily connect a provider when given one that is configured but not active.
- `loadSkill` may return provider guidance, but full tool descriptors come from
  `searchMcpTools` after provider connection.
- `searchMcpTools` returns focused descriptors including canonical `tool_name`, upstream `mcp_tool_name`, schemas, and annotations.
- Resumed skills recover runtime handles from the session log. They must not re-embed skill bodies or provider summaries into the prompt when those facts are already visible in Pi history.
- MCP OAuth uses `/api/oauth/callback/mcp/<plugin>` and resumes the paused agent run after authorization.
- Canonical MCP tool names remain `mcp__<plugin>__<tool>`.

## Plugin Skills

Plugin skills use the normal `SKILL.md` format and frontmatter contract.

When runtime loads a plugin-backed skill, it must:

1. Re-resolve the parent plugin from the skill path.
2. Reject stale or forged metadata that names a different plugin.
3. Rebuild loaded metadata from current `SKILL.md` frontmatter.
4. Prepend a host-owned runtime boundary derived from `plugin.yaml`.

Plugin-backed skills may explain provider commands, MCP tools, command env, config defaults, and provider-specific query syntax. They must not ask the model to install packages, run installers, configure API keys, configure OAuth, configure tokens, configure MCP endpoints, or repair sandbox package installation.

## Runtime Hook Plugins

Plugin runtime hooks are initialized from app code, not `plugin.yaml`.

Apps export one runtime-safe `defineJuniorPlugins(...)` set and point
`juniorNitro({ plugins: "./plugins" })` at it. `juniorNitro()` extracts package
names for build-time copying and emits a virtual module that imports the same
set at runtime. `createApp()` extracts plugin hooks from that virtual module
and validates that every registration has a matching manifest. Hook
factories carry their manifest inline, so runtime code is not declared from
`plugin.yaml`.

Hook contexts expose host capabilities to plugin code. Prefer direct standard
capabilities over bespoke restricting facades; add a wrapper only when it
represents a real model-visible, sandbox, credential, external-system,
lifecycle, or migration boundary. Do not add a facade merely to stop plugins
from seeing core schemas or ordinary host objects.
Tool registration contexts receive `ctx.model`, a host-owned structured
completion capability for plugin-owned semantic review before tool execution.
`ctx.model` accepts a strict schema plus prompt text and uses Junior's
configured model boundary without exposing provider credentials, SDK clients,
provider names, or model-visible tools to plugins. Plugins may pass a host
model id override for their own structured call; the host still owns provider
resolution and credentials. Tool registration contexts also receive
`ctx.embedder`, the separate host-owned embedding capability for derived
retrieval indexes. Current hook contracts are defined in
[Plugin Database Spec](./plugin-database.md), [Plugin CLI Spec](./plugin-cli.md),
[Plugin Heartbeat Spec](./plugin-heartbeat.md), [Plugin Dispatch
Spec](./plugin-dispatch.md), [Plugin Background Tasks
Spec](./plugin-tasks.md), [Plugin Prompt Hooks
Spec](./plugin-prompt-hooks.md), and [Resource Event Subscriptions
Spec](./resource-event-subscriptions.md). User prompt contexts receive only the narrow
embedding capability needed for retrieval-oriented prompt contributions; they
do not receive structured completion. Prompt hooks are exported by
`@sentry/junior-plugin-api` and invoked by Junior core. Plugin tasks are
registered as top-level app-code task definitions and run through the
core-owned background task queue. Plugin `migrateStorage` hooks are limited to
`junior upgrade` storage backfills after SQL schema migration; they are not
request-time runtime hooks and must not dispatch agent work.

Plugins may provide `routes` to mount host-owned HTTP handlers inside `createApp()`. Route handlers receive only the web-standard `Request` and return a `Response`; plugin API types must not expose Hono internals. Core mounts plugin routes after sandbox-egress detection and before Junior's built-in health, webhook, OAuth, and internal routes. `ALL` route methods are exclusive for a path and must not be combined with explicit methods. Route plugins that serve package assets must keep those assets reachable through package-local code imports or static file references; manifest plugin declarations are not the asset-registration path for plugin routes.

Provider plugins may use `routes` to receive provider webhooks for resource
event subscriptions. Those routes must verify provider signatures and normalize
payloads before calling the core resource-event ingestion boundary. Plugin
routes own provider payload parsing and resource ref construction; they must
not own Junior conversation routing, subscription storage, TTL, cancellation,
dedupe, or mailbox delivery. See [Resource Event Subscriptions
Spec](./resource-event-subscriptions.md).

Plugins may provide `dashboardRoutes` to mount a Hono app or fetch-compatible
app under Junior's authenticated dashboard API namespace. Core owns the mount
path and auth boundary:

```text
/api/dashboard/plugins/:pluginName/*
```

Dashboard route apps must not claim app-global routes. They are only available
when the core dashboard is enabled and inherit the dashboard's browser-session
authorization policy.

Plugins may also provide `slackConversationLink` to replace the finalized Slack footer conversation URL. The hook receives only the opaque conversation id and returns an absolute HTTP(S) URL; it does not expose dashboard data, Slack credentials, or model-facing tools.

## Security Properties

- Plugin manifests are committed YAML files, not dynamically loaded remote code.
- Credential delivery uses host-managed headers and credential-context-bound leases.
- Real secret values never enter sandbox env vars, files, command args, skill text, or model-visible tool args.
- Plugin manifests are parsed once at startup and are not mutated at runtime.
- Plugin prompt behavior must be local to the loaded skill or plugin tool guidance.

## Observability

- Plugin broker creation annotates active spans with `app.plugin.name`, `app.plugin.capabilities`, and `app.plugin.has_oauth`.
- `capability_catalog_loaded` includes plugin-sourced capabilities.

## Verification

- Package discovery is empty when no package names are configured.
- Registry load order is deterministic.
- Manifest validation fails before partial registration.
- Plugin-backed skill loading rejects forged plugin metadata.
- No MCP connections are made at agent-run start unless restoring providers from session-log connection events.
- `searchMcpTools` and `callMcpTool` cannot reach tools from providers that are not configured or failed activation.

## Related Specs

- `./plugin.md`
- `./plugin-manifest.md`
- `./credential-injection.md`
- `./agent-prompt.md`
- `./plugin-prompt-hooks.md`
- `./plugin-tasks.md`
- `./plugin-database.md`
- `./plugin-cli.md`
- `./plugin-heartbeat.md`
- `./plugin-dispatch.md`
- `./resource-event-subscriptions.md`
