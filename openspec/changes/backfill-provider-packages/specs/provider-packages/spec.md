## ADDED Requirements

### Requirement: First-Party Provider Packages

Junior SHALL publish each first-party provider integration as an explicit provider package with a stable package identity.

#### Scenario: Provider package identity is declared

- **GIVEN** a first-party provider integration is shipped as an npm package
- **WHEN** the package is installed by an application
- **THEN** its package name SHALL use the `@sentry/junior-<provider>` pattern
- **AND** its provider name SHALL match the provider name declared in `plugin.yaml`
- **AND** its package metadata SHALL point at the provider package directory in the Junior repository

#### Scenario: Provider package content is public

- **GIVEN** a first-party provider package is published
- **WHEN** the package is packed or installed
- **THEN** it SHALL include its `plugin.yaml`
- **AND** it SHALL include bundled `skills` when the provider exposes skill instructions
- **AND** it SHALL include any trusted runtime entrypoint exported by the package
- **AND** it SHALL NOT require source files outside the published package to discover its manifest or skills

### Requirement: Provider Manifest Ownership

Provider packages SHALL declare provider runtime setup in `plugin.yaml`, not in skill frontmatter or prompt-only instructions.

#### Scenario: Provider has conversation defaults

- **GIVEN** a provider supports conversation-scoped defaults such as repository, organization, project, team, service, or environment
- **WHEN** those defaults are configurable through Junior
- **THEN** the provider manifest SHALL declare the short keys in `config-keys`
- **AND** consumers SHALL address them with the fully qualified `<provider>.<key>` form at runtime

#### Scenario: Provider has a default target flag

- **GIVEN** provider commands need a canonical target flag such as `--repo`
- **WHEN** the provider manifest declares `target`
- **THEN** the target `config-key` SHALL be present in `config-keys`
- **AND** command flags SHALL be declared in the manifest instead of embedded as undocumented skill assumptions

#### Scenario: Provider needs host-managed credentials

- **GIVEN** a provider requires credentials, auth headers, or OAuth metadata
- **WHEN** the provider package is loaded
- **THEN** the provider manifest SHALL declare the credential type, domains, token placeholder, required host environment variables, OAuth endpoints, scopes, or API headers needed by the runtime
- **AND** bundled skills SHALL refer to the declared provider capability rather than hardcoding secrets or asking the user to paste tokens into Slack

#### Scenario: Provider needs runtime dependencies

- **GIVEN** a provider depends on a CLI, browser runtime, or system package in the sandbox
- **WHEN** the provider package is loaded into a runtime snapshot
- **THEN** the provider manifest SHALL declare `runtime-dependencies` and any required `runtime-postinstall` commands
- **AND** the runtime SHALL install or provision those dependencies through the plugin runtime dependency path
- **AND** the skill SHALL NOT instruct the model to install those dependencies ad hoc during a user turn

### Requirement: Provider Skills

Provider packages SHALL use bundled skills for provider-specific model guidance.

#### Scenario: Provider package includes skills

- **GIVEN** a provider package has model-facing usage guidance
- **WHEN** the package is discovered
- **THEN** each bundled skill SHALL be discoverable through the plugin runtime's skill discovery rules
- **AND** loading the skill SHALL associate it with the owning provider
- **AND** skill instructions SHALL rely on manifest-owned credentials, config keys, runtime dependencies, and MCP declarations

#### Scenario: Provider skill references external APIs

- **GIVEN** a provider skill describes commands, endpoints, or provider-specific behavior
- **WHEN** the external provider behavior may change independently of Junior
- **THEN** the package SHOULD include focused references or source notes that identify the provider surface the skill is based on
- **AND** evals for model-facing behavior SHALL check outcomes rather than exact prose copied from the skill

### Requirement: Hosted MCP Provider Packages

Hosted MCP provider packages SHALL declare remote MCP endpoint behavior through the manifest.

#### Scenario: Provider uses a hosted MCP server

- **GIVEN** a provider package uses a provider-hosted remote MCP server
- **WHEN** the package is loaded
- **THEN** the manifest SHALL declare the MCP URL, with environment interpolation only for documented endpoint overrides
- **AND** user authorization SHALL be handled by the MCP auth runtime
- **AND** the package SHALL NOT require a shared API key when the provider's documented default auth model is per-user MCP OAuth

#### Scenario: Hosted MCP package restricts tool exposure

- **GIVEN** a hosted MCP provider package declares `allowed-tools`
- **WHEN** the MCP server advertises tools
- **THEN** Junior SHALL expose only the allowlisted tools for that provider
- **AND** missing allowlisted tools SHALL fail clearly during activation or discovery

#### Scenario: Hosted MCP provider has no allowlist

- **GIVEN** a hosted MCP provider package does not declare `allowed-tools`
- **WHEN** the MCP server advertises tools
- **THEN** Junior MAY expose the provider-discovered tool set
- **AND** the provider-specific workflow spec or package worksheet SHALL document why provider discovery is trusted for that integration

### Requirement: Trusted Runtime Provider Hooks

Provider packages that need host-enforced runtime behavior SHALL expose trusted plugin hooks instead of relying on model instructions.

#### Scenario: Provider enforces git commit attribution

- **GIVEN** the GitHub provider needs bot author attribution and requester co-author attribution for sandbox git commits
- **WHEN** the application registers the GitHub trusted plugin
- **THEN** the plugin SHALL register the GitHub provider package
- **AND** sandbox preparation SHALL install host-controlled git hook configuration
- **AND** tool execution hooks SHALL inject bot and requester attribution environment only for the active requester context
- **AND** missing required attribution configuration SHALL deny affected git commit commands with an internal configuration error

#### Scenario: Provider exports trusted hooks

- **GIVEN** a first-party provider package exports trusted runtime hooks
- **WHEN** the package is published
- **THEN** the package SHALL include type declarations for the exported public entrypoint
- **AND** the exported hook factory SHALL keep provider package registration explicit
- **AND** the hook SHALL NOT conflict with core tool names or bypass plugin API validation

### Requirement: Provider Public Documentation

Every first-party provider package SHALL have public setup documentation aligned with its manifest and runtime behavior.

#### Scenario: Provider has host environment requirements

- **GIVEN** a provider manifest declares required host environment variables
- **WHEN** the provider's public setup page documents installation
- **THEN** the docs SHALL list the same required environment variables
- **AND** docs SHALL distinguish host-managed secrets from sandbox-visible command environment

#### Scenario: Provider has OAuth or per-user auth

- **GIVEN** a provider uses plugin OAuth or MCP OAuth
- **WHEN** public docs describe setup and verification
- **THEN** the docs SHALL identify the callback or hosted auth model
- **AND** docs SHALL state that authorization links are delivered privately
- **AND** docs SHALL state that Junior resumes the blocked Slack thread after successful authorization when the auth runtime supports resume

#### Scenario: Provider has runtime dependencies

- **GIVEN** a provider manifest declares runtime dependencies or postinstall commands
- **WHEN** public docs describe setup
- **THEN** the docs SHALL explain that dependency provisioning happens through the runtime snapshot/dependency path
- **AND** failure modes SHALL distinguish missing package configuration from failed dependency provisioning

### Requirement: Provider Workflow Scope

Provider package specs SHALL separate package/runtime contracts from provider workflow behavior.

#### Scenario: Provider workflow is target-sensitive or write-capable

- **GIVEN** a provider workflow creates, updates, deletes, comments on, or otherwise writes to an external provider
- **OR** target selection can reasonably choose the wrong external resource
- **WHEN** the workflow is covered by evals or product behavior
- **THEN** that behavior SHALL be specified in a provider-specific workflow spec
- **AND** this shared provider package spec SHALL reference only the package, manifest, auth, skill, and runtime boundaries needed by that workflow

#### Scenario: Provider workflow is package-only

- **GIVEN** a provider package only needs package discovery, manifest validation, auth activation, and skill loading coverage
- **WHEN** no provider-specific behavior contract is established
- **THEN** this shared provider package spec MAY be the only baseline spec for that provider
- **AND** gaps SHALL be recorded as open questions rather than implied behavior

### Requirement: Provider Package Verification

Provider package changes SHALL be verified at the layer matching the behavior being changed.

#### Scenario: Package artifact or manifest changes

- **GIVEN** a change modifies package metadata, `plugin.yaml`, package files, runtime dependencies, postinstall commands, config keys, OAuth metadata, MCP URLs, or trusted hook exports
- **WHEN** verification is run
- **THEN** unit or integration tests SHALL validate package discovery, manifest parsing, runtime dependency planning, hook registration, and built app discovery as applicable

#### Scenario: Provider skill behavior changes

- **GIVEN** a change modifies provider skill guidance that affects model-facing behavior
- **WHEN** verification is run
- **THEN** evals SHALL cover the user-visible provider workflow
- **AND** eval names and rubrics SHALL describe the behavior being judged rather than the package mechanism

#### Scenario: Public provider docs change

- **GIVEN** a change modifies provider setup docs or manifest-declared setup
- **WHEN** verification is planned
- **THEN** docs and manifest fields SHALL be checked for consistency
- **AND** any missing automated drift check SHALL be recorded as a verification gap
