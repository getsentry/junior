## ADDED Requirements

### Requirement: Manifest identity and parsing

Junior SHALL parse each plugin manifest as a YAML object with stable provider identity.

#### Scenario: Manifest has required identity fields

- **WHEN** a plugin manifest is parsed
- **THEN** it SHALL declare a lowercase kebab-case `name` and a non-empty `description`

#### Scenario: Manifest name is invalid

- **WHEN** `name` does not match Junior's plugin-name grammar
- **THEN** manifest parsing SHALL fail before registration

#### Scenario: Optional arrays are absent

- **WHEN** optional arrays such as `capabilities` or `config-keys` are absent
- **THEN** Junior SHALL treat them as empty arrays

#### Scenario: Unknown fields are present

- **WHEN** a manifest includes unknown root fields
- **THEN** Junior SHALL NOT derive runtime behavior from those fields

### Requirement: Manifest configuration overrides

Junior SHALL apply installation-level manifest overrides before validating or registering effective manifests.

#### Scenario: Override patches a manifest

- **WHEN** `PluginConfig.manifests.<plugin>` provides field overrides
- **THEN** Junior SHALL merge those overrides into the raw manifest before validation and duplicate checks

#### Scenario: Override removes an optional field

- **WHEN** an override sets a nullable manifest field or map entry to `null`
- **THEN** Junior SHALL remove that field or entry from the effective manifest before validation

#### Scenario: Override attempts to rename plugin

- **WHEN** an override changes the manifest `name`
- **THEN** Junior SHALL reject the override

#### Scenario: Override references missing plugin

- **WHEN** registry loading completes and `PluginConfig.manifests` names a plugin that was not loaded
- **THEN** Junior SHALL fail validation instead of silently ignoring the override

### Requirement: Capabilities and config keys

Junior SHALL normalize manifest capability and configuration-key declarations into plugin-qualified identifiers.

#### Scenario: Capabilities are declared

- **WHEN** a plugin declares capability tokens
- **THEN** Junior SHALL validate each token and expose each capability as `<plugin>.<capability>`

#### Scenario: Config keys are declared

- **WHEN** a plugin declares configuration-key tokens
- **THEN** Junior SHALL validate each token and expose each key as `<plugin>.<key>`

#### Scenario: Capability duplicates another plugin

- **WHEN** two loaded plugins expose the same qualified capability
- **THEN** registry loading SHALL fail

### Requirement: Provider domain ownership

Junior SHALL use effective manifest domains as the registry authority for provider-domain ownership.

#### Scenario: Domains are declared

- **WHEN** a manifest declares `domains` or credential `domains`
- **THEN** Junior SHALL validate them as exact hostnames, normalize them to lowercase, and associate them with the plugin

#### Scenario: Top-level domains lack credential or header use

- **WHEN** a manifest declares top-level `domains` without credentials or API headers
- **THEN** parsing SHALL fail because the domain ownership would have no runtime purpose

#### Scenario: API headers lack domains

- **WHEN** a manifest declares top-level `api-headers` without top-level `domains`
- **THEN** parsing SHALL fail

#### Scenario: Domain is owned by another plugin

- **WHEN** two loaded plugins declare the same effective provider domain
- **THEN** registry loading SHALL fail and identify the conflicting owner

### Requirement: Environment variable declarations

Junior SHALL require manifest placeholders to reference declared environment variables.

#### Scenario: Env var key is invalid

- **WHEN** an `env-vars` key does not match `[A-Z_][A-Z0-9_]*`
- **THEN** manifest parsing SHALL fail

#### Scenario: Placeholder references undeclared env var

- **WHEN** a manifest field uses `${VAR}` and `VAR` is not declared in `env-vars`
- **THEN** manifest parsing SHALL fail for fields that expand during manifest parsing

#### Scenario: Default-backed placeholder is expanded

- **WHEN** a manifest-expanded field references `${VAR}`, process env is unset, and `env-vars.VAR.default` is present
- **THEN** Junior SHALL substitute the declared default

#### Scenario: Process env overrides default

- **WHEN** a manifest-expanded field references `${VAR}` and process env has a non-empty value
- **THEN** Junior SHALL substitute the process env value instead of the default

#### Scenario: Required manifest-expanded env var is unset

- **WHEN** a manifest-expanded field references `${VAR}`, process env is unset, and no default is declared
- **THEN** manifest parsing SHALL fail

#### Scenario: Command env references secret-only env var

- **WHEN** `command-env` references env vars declared for API headers, OAuth client secrets, or credentials
- **THEN** manifest parsing SHALL fail

#### Scenario: Defaultless command env reference remains host-bound

- **WHEN** `command-env` references a declared env var without a default
- **THEN** Junior SHALL keep that reference for host-side command-env resolution and SHALL NOT resolve it during manifest parsing

### Requirement: API header declarations

Junior SHALL validate API header declarations as provider-domain-bound header templates.

#### Scenario: API headers are empty

- **WHEN** `api-headers` is present but contains no headers
- **THEN** manifest parsing SHALL fail

#### Scenario: Header env var is undeclared

- **WHEN** an API header value references an undeclared env var
- **THEN** manifest parsing SHALL fail

#### Scenario: Header env var has a default

- **WHEN** an API header value references an env var that declares a default
- **THEN** manifest parsing SHALL fail because header secrets must come from host-provided env

#### Scenario: Credential API header uses Authorization

- **WHEN** credential-scoped `api-headers` includes `Authorization`
- **THEN** manifest parsing SHALL fail because credential brokers own authorization headers

### Requirement: Credential declarations

Junior SHALL validate credential declarations before registering provider brokers.

#### Scenario: OAuth bearer credentials are declared

- **WHEN** `credentials.type` is `oauth-bearer`
- **THEN** the manifest SHALL declare credential domains and an uppercase `auth-token-env`

#### Scenario: GitHub App credentials are declared

- **WHEN** `credentials.type` is `github-app`
- **THEN** the manifest SHALL declare credential domains, `auth-token-env`, `app-id-env`, `private-key-env`, and `installation-id-env`

#### Scenario: Credential declaration has no domains

- **WHEN** `credentials` omits domains
- **THEN** manifest parsing SHALL fail

#### Scenario: Credential env var is invalid

- **WHEN** a credential env field does not match the env-var grammar
- **THEN** manifest parsing SHALL fail

### Requirement: OAuth declarations

Junior SHALL treat manifest OAuth configuration as provider metadata for runtime-controlled OAuth flows.

#### Scenario: OAuth config lacks credentials

- **WHEN** a manifest declares `oauth` without credentials
- **THEN** parsing SHALL fail

#### Scenario: OAuth config uses unsupported credentials

- **WHEN** a manifest declares `oauth` with non-`oauth-bearer` credentials
- **THEN** parsing SHALL fail

#### Scenario: OAuth endpoints are not HTTPS

- **WHEN** `authorization-url` or `token-url` is not HTTPS
- **THEN** manifest parsing SHALL fail

#### Scenario: Reserved authorize param is declared

- **WHEN** `authorize-params` includes `client_id`, `scope`, `state`, `redirect_uri`, or `response_type`
- **THEN** manifest parsing SHALL fail because runtime owns those parameters

#### Scenario: Token header uses Authorization

- **WHEN** OAuth token extra headers include `Authorization`
- **THEN** manifest parsing SHALL fail because the token authentication method owns client authentication

#### Scenario: Token auth method is declared

- **WHEN** `token-auth-method` is present
- **THEN** Junior SHALL accept only supported methods `body` and `basic`

### Requirement: Runtime dependency declarations

Junior SHALL validate runtime dependency and post-install declarations as constrained setup metadata.

#### Scenario: NPM dependency is declared

- **WHEN** a runtime dependency has `type: npm`
- **THEN** it SHALL declare a package name and MAY declare a version that defaults to `latest`

#### Scenario: System package dependency is declared

- **WHEN** a runtime dependency has `type: system`
- **THEN** it SHALL declare a package name and SHALL NOT declare a version or URL hash

#### Scenario: System URL dependency is declared

- **WHEN** a runtime dependency has `type: system-url`
- **THEN** it SHALL declare an HTTPS URL and a 64-character lowercase hexadecimal SHA-256 digest

#### Scenario: Duplicate runtime dependency is declared

- **WHEN** equivalent runtime dependency entries repeat
- **THEN** Junior SHALL keep one effective entry

#### Scenario: Post-install command is declared

- **WHEN** `runtime-postinstall` is present
- **THEN** each command SHALL declare a single executable token, optional non-empty args, and optional sudo flag

### Requirement: MCP declarations

Junior SHALL validate manifest MCP configuration as constrained remote MCP provider metadata.

#### Scenario: MCP config is declared

- **WHEN** `mcp` is present
- **THEN** it SHALL use transport `http`, an HTTPS URL after env expansion, and a non-empty `allowed-tools` list

#### Scenario: MCP transport is unsupported

- **WHEN** `mcp.transport` is not `http`
- **THEN** manifest parsing SHALL fail

#### Scenario: MCP header uses Authorization

- **WHEN** `mcp.headers` includes `Authorization`
- **THEN** manifest parsing SHALL fail because MCP authorization is runtime-owned

#### Scenario: MCP URL references unset env var

- **WHEN** `mcp.url` references a declared env var that is unset and has no default
- **THEN** manifest parsing SHALL fail

### Requirement: Target declarations

Junior SHALL validate target declarations against the plugin's declared configuration keys.

#### Scenario: Target is declared

- **WHEN** a manifest declares `target`
- **THEN** it SHALL include a target `type` and a `config-key` declared in the manifest's `config-keys`

#### Scenario: Target command flags are declared

- **WHEN** a target declares command flags
- **THEN** each flag SHALL use a valid command-flag shape

#### Scenario: Target config key is unknown

- **WHEN** target `config-key` is not present in `config-keys`
- **THEN** manifest parsing SHALL fail

### Requirement: Package discovery and registry loading

Junior SHALL discover configured plugin package content and register effective plugin manifests deterministically.

#### Scenario: Package list is configured

- **WHEN** `PluginConfig.packages` is provided
- **THEN** Junior SHALL normalize package names, remove duplicates, and resolve configured packages from installed package content

#### Scenario: Package has no plugin content

- **WHEN** a configured package has no `plugin.yaml`, `plugins/`, or `skills/` content
- **THEN** package discovery SHALL fail

#### Scenario: Root manifest exists

- **WHEN** a plugin root contains `plugin.yaml`
- **THEN** registry loading SHALL register that root as one plugin and SHALL NOT scan child plugin directories under it

#### Scenario: Plugin root contains child plugins

- **WHEN** a plugin root has no root manifest
- **THEN** registry loading SHALL scan sorted child directories for manifests

#### Scenario: Duplicate plugin name is loaded

- **WHEN** two loaded manifests have the same plugin name
- **THEN** registry loading SHALL fail

#### Scenario: Catalog source changes

- **WHEN** local roots, package content, or plugin config changes
- **THEN** registry accessors SHALL rebuild the loaded plugin state from the new catalog source

### Requirement: CLI manifest validation

Junior SHALL expose manifest validation through the check CLI.

#### Scenario: Local app plugin is valid

- **WHEN** `junior check` scans a repo with valid `app/plugins/*/plugin.yaml`
- **THEN** it SHALL report validated plugin manifests and plugin skills

#### Scenario: Packaged plugin is valid

- **WHEN** `junior check` scans configured installed plugin packages
- **THEN** it SHALL validate packaged manifests and packaged skills

#### Scenario: Plugin manifest is outside app plugin root

- **WHEN** a repo contains plugin-like files outside the app plugin search path
- **THEN** the check CLI SHALL ignore them

### Requirement: Manifest verification taxonomy

Junior SHALL verify manifest behavior at the lowest deterministic layer that proves the contract.

#### Scenario: Syntax or normalization behavior changes

- **WHEN** manifest parser, patching, env expansion, or duplicate registration behavior changes
- **THEN** unit tests SHALL cover the changed scenarios

#### Scenario: CLI validation behavior changes

- **WHEN** check CLI discovery, output, or failure behavior changes
- **THEN** CLI tests SHALL cover the changed scenarios

#### Scenario: Runtime consumption changes

- **WHEN** manifest declarations affect brokers, OAuth, MCP, sandbox setup, or credential injection
- **THEN** integration tests SHALL cover the runtime wiring at the consuming boundary

#### Scenario: Agent-visible plugin availability changes

- **WHEN** manifest changes alter which capabilities or skills the agent can use
- **THEN** evals MAY cover the user-visible agent behavior, but SHALL NOT be the primary test layer for manifest syntax
