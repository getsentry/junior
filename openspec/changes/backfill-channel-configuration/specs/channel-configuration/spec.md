## ADDED Requirements

### Requirement: Configuration key and value validation

Junior SHALL treat channel configuration as non-secret provider configuration.

#### Scenario: Key is valid

- **WHEN** a configuration key is non-empty dotted lowercase namespace text such as `github.repo`
- **THEN** the key SHALL pass syntax validation

#### Scenario: Key syntax is invalid

- **WHEN** a configuration key is empty or does not match the dotted lowercase namespace grammar
- **THEN** validation SHALL fail

#### Scenario: Key appears secret-related

- **WHEN** a configuration key includes secret-like terms such as token, secret, password, API key, credential, auth, or private key
- **THEN** validation SHALL fail

#### Scenario: Value appears to contain secret material

- **WHEN** a configuration value contains recognizable secret material in nested string values or object keys
- **THEN** validation SHALL fail

### Requirement: Conversation configuration service

Junior SHALL persist mutable channel configuration as conversation-scoped entries.

#### Scenario: Entry is set

- **WHEN** a configuration entry is set
- **THEN** Junior SHALL validate key and value, normalize scope to `conversation`, record update time, optional updater, optional source, optional expiry, persist state, and return the entry

#### Scenario: Entry is retrieved

- **WHEN** a configuration key is retrieved
- **THEN** Junior SHALL return the stored entry for the trimmed key or `undefined`

#### Scenario: Entries are listed

- **WHEN** configuration entries are listed
- **THEN** Junior SHALL return entries sorted by key and optionally filtered by prefix

#### Scenario: Entry is resolved

- **WHEN** a configuration key is resolved
- **THEN** Junior SHALL return only the entry value or `undefined`

#### Scenario: Values are resolved

- **WHEN** configuration values are resolved with optional keys or prefix
- **THEN** Junior SHALL return a key/value object containing matching stored values

#### Scenario: Entry is unset

- **WHEN** an existing configuration key is unset
- **THEN** Junior SHALL delete the entry, persist state, and return `true`

#### Scenario: Missing entry is unset

- **WHEN** a missing configuration key is unset
- **THEN** Junior SHALL return `false`

#### Scenario: Legacy persisted channel scope is loaded

- **WHEN** persisted state contains an entry with legacy `channel` scope
- **THEN** Junior SHALL coerce it to `conversation` scope

#### Scenario: Persisted entry is malformed

- **WHEN** persisted configuration state contains malformed entries
- **THEN** Junior SHALL ignore those entries during coercion

### Requirement: Install-wide configuration defaults

Junior SHALL support install-wide defaults only for registered plugin config keys.

#### Scenario: Defaults are undefined

- **WHEN** install defaults are set to `undefined`
- **THEN** Junior SHALL clear install defaults

#### Scenario: Defaults are not an object

- **WHEN** install defaults are not a plain object
- **THEN** validation SHALL fail

#### Scenario: Default key is unregistered

- **WHEN** an install default key is not a registered plugin config key
- **THEN** validation SHALL fail

#### Scenario: Defaults are returned

- **WHEN** callers read install defaults
- **THEN** Junior SHALL return a defensive clone

### Requirement: Runtime configuration precedence

Junior SHALL build effective turn configuration from defaults, explicit context, and persisted conversation values in deterministic order.

#### Scenario: Turn starts with configuration sources

- **WHEN** a turn starts
- **THEN** effective configuration SHALL merge install defaults first, then explicit context configuration, then persisted conversation configuration

#### Scenario: Persisted value conflicts with default

- **WHEN** persisted conversation configuration has the same key as an install default
- **THEN** the persisted conversation value SHALL win

#### Scenario: Context value conflicts with default

- **WHEN** explicit context configuration has the same key as an install default
- **THEN** the explicit context value SHALL win unless persisted conversation configuration overrides it

#### Scenario: Runtime config changes mid-turn

- **WHEN** `jr-rpc config set` or `unset` changes a value during a turn
- **THEN** the in-memory effective configuration for that turn SHALL be updated consistently

### Requirement: Jr-rpc configuration command

Junior SHALL expose deterministic configuration commands through the `jr-rpc` custom sandbox command.

#### Scenario: Command is not jr-rpc

- **WHEN** a sandbox command does not start with `jr-rpc`
- **THEN** the custom command handler SHALL report it was not handled

#### Scenario: Active conversation context is missing

- **WHEN** a `jr-rpc config` command runs without channel configuration service
- **THEN** it SHALL fail with a clear command error

#### Scenario: Config get is valid

- **WHEN** `jr-rpc config get <key>` runs
- **THEN** it SHALL return JSON describing the entry or `{ found: false }`

#### Scenario: Config set is valid

- **WHEN** `jr-rpc config set <key> <value>` runs
- **THEN** it SHALL store the string value with source `jr-rpc`, updater when available, and report the entry as JSON

#### Scenario: Config set uses JSON

- **WHEN** `jr-rpc config set <key> <value> --json` runs
- **THEN** Junior SHALL parse the value as JSON before storing it

#### Scenario: Config set JSON is invalid

- **WHEN** `--json` value cannot be parsed
- **THEN** the command SHALL fail with usage-compatible command output

#### Scenario: Config unset is valid

- **WHEN** `jr-rpc config unset <key>` runs
- **THEN** it SHALL unset the value and report whether deletion occurred

#### Scenario: Config list is valid

- **WHEN** `jr-rpc config list` runs with optional `--prefix`
- **THEN** it SHALL return JSON entries sorted by key and filtered by prefix when present

#### Scenario: Config command usage is invalid

- **WHEN** command arguments do not match supported forms
- **THEN** the command SHALL return usage text and non-zero exit code

### Requirement: Provider default shortcut

Junior SHALL support explicit natural-language shortcuts for provider defaults only when they are deterministic.

#### Scenario: GitHub repo default request matches

- **WHEN** a user explicitly asks to set/use the default GitHub repo to `owner/repo` for the current channel
- **THEN** Junior SHALL set `github.repo` through the channel configuration service with source `provider-default-config`

#### Scenario: No channel configuration exists

- **WHEN** the GitHub repo default request matches but no channel configuration service is available
- **THEN** Junior SHALL NOT apply the shortcut

#### Scenario: Request does not match deterministic pattern

- **WHEN** a user message does not match a supported provider-default shortcut
- **THEN** Junior SHALL NOT mutate configuration through this shortcut

### Requirement: Resume configuration projection

Junior SHALL preserve effective configuration across resumable turn boundaries without allowing resumed context mutation through a read-only projection.

#### Scenario: Resume context has persisted configuration

- **WHEN** a turn resumes with saved configuration values
- **THEN** Junior SHALL provide those values to the resumed reply context

#### Scenario: Resumed code attempts to mutate read-only configuration

- **WHEN** a read-only resume configuration service receives set or unset
- **THEN** it SHALL fail

#### Scenario: Read-only configuration is resolved

- **WHEN** a read-only resume configuration service resolves values
- **THEN** it SHALL support get, list, resolve, and resolveValues from saved values

### Requirement: Configuration ownership boundaries

Junior SHALL keep provider configuration separate from credentials and plugin manifests.

#### Scenario: Plugin declares config keys

- **WHEN** a plugin manifest declares config keys
- **THEN** plugin runtime SHALL expose those keys as registered plugin config keys

#### Scenario: Skill frontmatter declares uses-config

- **WHEN** a skill uses deprecated `uses-config` frontmatter
- **THEN** skill validation SHALL reject it because plugin manifests own config-key declarations

#### Scenario: Credentials are needed

- **WHEN** a provider requires tokens, OAuth, API headers, or private keys
- **THEN** those secrets SHALL be handled by plugin auth/credential injection, not channel configuration

### Requirement: Channel configuration verification taxonomy

Junior SHALL verify channel configuration behavior at deterministic service and runtime layers.

#### Scenario: Service validation or persistence changes

- **WHEN** key/value validation, set/get/list/resolve/unset, or persisted coercion changes
- **THEN** unit tests SHALL cover the configuration service

#### Scenario: Jr-rpc command behavior changes

- **WHEN** command parsing, output, or mutation behavior changes
- **THEN** unit tests SHALL cover `jr-rpc` command scenarios

#### Scenario: Runtime merge or resume behavior changes

- **WHEN** effective configuration precedence or resume projection changes
- **THEN** integration or runtime tests SHALL cover the behavior

#### Scenario: Natural-language default shortcut changes

- **WHEN** deterministic provider-default shortcut behavior changes
- **THEN** Slack integration tests or evals SHALL cover user-visible behavior
