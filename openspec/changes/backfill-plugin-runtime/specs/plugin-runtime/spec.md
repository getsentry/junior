## ADDED Requirements

### Requirement: Explicit plugin discovery

Junior SHALL discover plugin runtime content only from explicit local roots and configured plugin packages.

#### Scenario: No plugin packages are configured

- **WHEN** installed packages exist in `node_modules` but no plugin package names are configured
- **THEN** Junior SHALL NOT discover plugin package content from `node_modules`

#### Scenario: Package names are configured

- **WHEN** `PluginConfig.packages` declares package names
- **THEN** Junior SHALL resolve those installed packages and include their manifest roots and skill roots

#### Scenario: Package is missing

- **WHEN** a configured package cannot be resolved
- **THEN** plugin discovery SHALL fail loudly

#### Scenario: Package has no plugin content

- **WHEN** a configured package resolves but has no `plugin.yaml`, `plugins/`, or `skills/`
- **THEN** plugin discovery SHALL fail loudly

#### Scenario: Local plugin root is unreadable

- **WHEN** a local plugin root cannot be read
- **THEN** Junior MAY warn and continue with other roots

### Requirement: App plugin configuration lifecycle

Junior SHALL apply plugin configuration during app creation with rollback on validation failure.

#### Scenario: PluginConfig is provided

- **WHEN** `createApp` receives `plugins` as `PluginConfig`
- **THEN** Junior SHALL set that config as the active plugin catalog configuration

#### Scenario: Trusted plugin array is provided

- **WHEN** `createApp` receives `plugins` as `JuniorPlugin[]`
- **THEN** Junior SHALL validate trusted plugins, merge package config declared by those plugins with build-time plugin config, and register trusted hooks

#### Scenario: Explicit trusted plugins are provided

- **WHEN** `plugins` is a trusted plugin array
- **THEN** Junior SHALL NOT read the legacy env plugin-package fallback

#### Scenario: Plugin validation fails during app creation

- **WHEN** app creation fails while validating plugin config, trusted plugins, or config defaults
- **THEN** Junior SHALL restore the previous plugin config, trusted plugins, and config defaults

### Requirement: Deterministic registry loading

Junior SHALL publish plugin registry state only after an effective catalog validates.

#### Scenario: Registry builds from catalog source

- **WHEN** registry accessors are called
- **THEN** Junior SHALL build state from local roots, packaged content, and plugin config signature

#### Scenario: Catalog source is unchanged

- **WHEN** the catalog signature is unchanged
- **THEN** registry accessors MAY reuse the cached loaded plugin state

#### Scenario: Catalog source changes

- **WHEN** local roots, package content, or plugin config changes
- **THEN** registry accessors SHALL rebuild state from the new catalog source

#### Scenario: Registry reload fails

- **WHEN** a new catalog source fails validation
- **THEN** Junior SHALL NOT expose a partially loaded registry as the active state

#### Scenario: Plugin root has root manifest

- **WHEN** a discovered plugin root contains `plugin.yaml`
- **THEN** Junior SHALL register that root as one plugin and SHALL NOT scan child directories under it

#### Scenario: Plugin root has child manifests

- **WHEN** a discovered plugin root has no root manifest
- **THEN** Junior SHALL scan sorted child directories for `plugin.yaml`

### Requirement: Registry public surfaces

Junior SHALL expose registered plugin metadata through narrow registry accessors.

#### Scenario: Capability providers are requested

- **WHEN** callers request plugin capability providers
- **THEN** Junior SHALL return provider, capabilities, config keys, and target metadata derived from effective manifests

#### Scenario: Plugin providers are requested

- **WHEN** callers request plugin providers
- **THEN** Junior SHALL return registered plugin definitions without exposing mutable registry internals

#### Scenario: OAuth config is requested

- **WHEN** callers request OAuth config for a provider with manifest OAuth metadata
- **THEN** Junior SHALL return a runtime OAuth provider config with callback path `/api/oauth/callback/<provider>`

#### Scenario: Skill roots are requested

- **WHEN** callers request plugin skill roots
- **THEN** Junior SHALL return manifest-owned plugin skill roots plus packaged skill roots without duplicates

#### Scenario: Runtime dependency inputs are requested

- **WHEN** callers request plugin runtime dependencies or postinstall commands
- **THEN** Junior SHALL return effective manifest declarations in deterministic form

#### Scenario: Unknown provider is queried

- **WHEN** callers query unknown plugin providers, capabilities, or config keys
- **THEN** Junior SHALL report absence without inventing fallback providers

### Requirement: Capability catalog integration

Junior SHALL build the capability catalog from plugin registry providers.

#### Scenario: Plugin capability is registered

- **WHEN** a plugin exposes a qualified capability
- **THEN** `getCapabilityProvider` and known-capability checks SHALL resolve it through the catalog

#### Scenario: Plugin catalog signature changes

- **WHEN** the plugin catalog signature changes
- **THEN** the capability catalog SHALL refresh cached providers

#### Scenario: Capability provider data is returned

- **WHEN** callers list or get capability providers
- **THEN** Junior SHALL return defensive copies of provider metadata

### Requirement: Plugin skill discovery and loading

Junior SHALL associate plugin-backed skills with their current parent plugin and prepend a runtime-boundary notice when loaded.

#### Scenario: Plugin skill is discovered

- **WHEN** a skill directory lives under a registered plugin's `skills` directory
- **THEN** skill discovery SHALL mark the skill with that plugin provider

#### Scenario: Config-only plugin has skills

- **WHEN** a plugin declares only config keys and skills
- **THEN** Junior SHALL still discover those plugin skills

#### Scenario: Plugin skill is loaded

- **WHEN** a plugin-backed skill body is loaded for the agent
- **THEN** Junior SHALL re-resolve plugin ownership from the current skill path and prepend a host-owned plugin runtime boundary derived from the manifest

#### Scenario: Skill metadata forges plugin ownership

- **WHEN** loaded skill metadata names a plugin that does not own the skill path
- **THEN** skill loading SHALL fail

#### Scenario: Skill frontmatter changes between discovery and load

- **WHEN** `SKILL.md` frontmatter is invalid or deprecated at load time
- **THEN** skill loading SHALL fail or omit the invalid skill according to the skill-runtime contract

### Requirement: Broker creation routing

Junior SHALL construct credential brokers from registered plugin manifests.

#### Scenario: Provider is unknown

- **WHEN** `createPluginBroker` is called for an unregistered provider
- **THEN** Junior SHALL throw an unknown-provider error

#### Scenario: Provider has API headers but no credentials

- **WHEN** a registered provider declares top-level API headers but no credentials
- **THEN** Junior SHALL create an API-header broker

#### Scenario: Provider has OAuth bearer credentials

- **WHEN** a registered provider declares `oauth-bearer` credentials
- **THEN** Junior SHALL create the generic OAuth bearer broker

#### Scenario: Provider has GitHub App credentials

- **WHEN** a registered provider declares `github-app` credentials
- **THEN** Junior SHALL create a GitHub App broker

#### Scenario: Provider has no credential surface

- **WHEN** a registered provider has neither credentials nor API headers
- **THEN** broker creation SHALL fail with a provider-scoped no-credentials error

### Requirement: MCP provider exposure

Junior SHALL expose manifest-configured MCP providers without connecting them at registry load.

#### Scenario: MCP providers are requested

- **WHEN** callers request plugin MCP providers
- **THEN** Junior SHALL return only registered plugins with manifest MCP declarations

#### Scenario: Registry loads MCP plugin

- **WHEN** registry loads a plugin with `mcp`
- **THEN** Junior SHALL NOT connect to the MCP server during registry load

#### Scenario: Runtime uses MCP provider

- **WHEN** a turn searches or calls a configured MCP provider
- **THEN** MCP activation SHALL be handled by the MCP runtime, not by registry loading

### Requirement: Trusted app plugin registration

Junior SHALL register trusted app plugins only through app code with validated identity and narrow hook contexts.

#### Scenario: Trusted plugin name is invalid

- **WHEN** a trusted plugin name is not a lowercase plugin identifier
- **THEN** app creation SHALL fail before mutating registered trusted plugins

#### Scenario: Trusted plugin names duplicate

- **WHEN** two trusted plugins have the same name
- **THEN** app creation SHALL fail before mutating registered trusted plugins

#### Scenario: Legacy state prefix is outside namespace

- **WHEN** a trusted plugin declares a legacy state prefix outside `junior:<plugin>`
- **THEN** validation SHALL fail

#### Scenario: Trusted tools are collected

- **WHEN** trusted plugin tools are collected for a turn
- **THEN** Junior SHALL call each plugin's tool hook with requester/channel context, plugin-scoped state, and plugin logger

#### Scenario: Trusted tool name is invalid or duplicate

- **WHEN** a trusted plugin returns an invalid or duplicate tool name
- **THEN** Junior SHALL fail tool collection

#### Scenario: Tool lifecycle hook denies execution

- **WHEN** a trusted plugin `beforeToolExecute` hook denies a tool
- **THEN** Junior SHALL stop execution with a plugin hook denial error

#### Scenario: Sandbox prepare hook runs

- **WHEN** a sandbox is prepared for a turn and trusted plugins expose sandbox hooks
- **THEN** Junior SHALL invoke those hooks with a narrow sandbox capability

### Requirement: Plugin runtime security boundaries

Junior SHALL keep plugin runtime authority in host-controlled configuration and code.

#### Scenario: Skill prose asks to configure runtime setup

- **WHEN** plugin skill prose asks the model to install packages, configure credentials, create OAuth clients, or set up MCP servers
- **THEN** the host-owned plugin runtime boundary SHALL instruct the agent that manifest/runtime setup controls those surfaces

#### Scenario: Manifest declares credentials

- **WHEN** a plugin declares credential requirements
- **THEN** real secret values SHALL remain host-managed and SHALL NOT be placed in skill text, model-visible tool args, sandbox files, or sandbox command env by the registry

#### Scenario: Runtime prompt is built

- **WHEN** core prompt context is built
- **THEN** Junior SHALL NOT hard-code plugin-specific behavior into the core prompt; plugin-specific guidance SHALL come from loaded skills, tools, schemas, and runtime-provided descriptors

### Requirement: Plugin runtime verification taxonomy

Junior SHALL verify plugin runtime behavior at the layer that owns the contract.

#### Scenario: Discovery or registry behavior changes

- **WHEN** package discovery, app config, registry accessors, duplicate checks, or rollback behavior changes
- **THEN** unit tests SHALL cover the changed behavior

#### Scenario: Plugin skill behavior changes

- **WHEN** plugin skill discovery, ownership, or runtime-boundary injection changes
- **THEN** skill-runtime unit tests SHALL cover the changed behavior

#### Scenario: Runtime consumption changes

- **WHEN** brokers, OAuth, MCP, sandbox snapshots, or credential injection consume plugin registry data differently
- **THEN** integration tests SHALL cover the consuming runtime boundary

#### Scenario: Agent-visible plugin behavior changes

- **WHEN** plugin availability changes what the agent can do in user workflows
- **THEN** evals MAY cover the user-visible behavior, but SHALL NOT be the primary test layer for registry mechanics
