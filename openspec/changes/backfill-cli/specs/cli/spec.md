## ADDED Requirements

### Requirement: Published CLI Binary

Junior SHALL expose a package binary named `junior` from the `@sentry/junior` package.

#### Scenario: Package binary is installed

- **WHEN** `@sentry/junior` is installed as a package dependency
- **THEN** package managers SHALL be able to link a `junior` executable from the package `bin` field
- **AND** the executable SHALL load built CLI modules from the published package artifact

#### Scenario: Bin wrapper references CLI modules

- **WHEN** the bin wrapper dynamically loads a CLI module
- **THEN** the build configuration SHALL include that module in the emitted `dist/cli` output
- **AND** missing required CLI exports SHALL fail with an actionable reinstall/retry error

### Requirement: Command Dispatch

Junior CLI SHALL support only documented command forms unless a new command is explicitly specified.

#### Scenario: Init command is valid

- **WHEN** the CLI receives `junior init <dir>`
- **THEN** it SHALL run the init command for the provided directory and exit successfully if init succeeds

#### Scenario: Snapshot create command is valid

- **WHEN** the CLI receives `junior snapshot create`
- **THEN** it SHALL run snapshot warmup and exit successfully if snapshot warmup succeeds

#### Scenario: Check command is valid

- **WHEN** the CLI receives `junior check`
- **THEN** it SHALL validate the current working directory

#### Scenario: Check command has a directory argument

- **WHEN** the CLI receives `junior check <dir>`
- **THEN** it SHALL validate the provided directory

#### Scenario: Command form is invalid

- **WHEN** the CLI receives an unknown command, a missing required argument, or extra positional arguments
- **THEN** it SHALL print CLI usage to stderr
- **AND** it SHALL return a non-zero exit code
- **AND** it SHALL NOT run any command handler

#### Scenario: Command handler throws

- **WHEN** a command handler throws an error
- **THEN** the process entrypoint SHALL print `junior command failed: <message>` to stderr
- **AND** it SHALL exit non-zero

### Requirement: CLI Environment Loading

Junior CLI SHALL load local environment files before executing commands.

#### Scenario: CLI runs from nested app directory

- **WHEN** the CLI starts from a nested path inside a package or workspace
- **THEN** it SHALL consider the current directory, nearest package roots, and workspace root markers as env roots
- **AND** it SHALL load existing env files from those roots before command execution

#### Scenario: Environment files are mode-specific

- **WHEN** `NODE_ENV` is set
- **THEN** CLI env loading SHALL consider `.env.<mode>.local`, `.env.local` except in `test`, `.env.<mode>`, and `.env` in that order per root

#### Scenario: Shell env already has a value

- **WHEN** a variable is already set in `process.env`
- **THEN** env loading SHALL NOT overwrite that value with an env-file value

### Requirement: Init Scaffold

`junior init <dir>` SHALL create a supported Junior app scaffold only in a safe target directory.

#### Scenario: Target directory does not exist

- **WHEN** init receives a path that does not exist
- **THEN** it SHALL create the directory and scaffold the app

#### Scenario: Target directory is empty

- **WHEN** init receives an existing empty directory
- **THEN** it SHALL scaffold the app in that directory

#### Scenario: Target is unsafe

- **WHEN** init receives a file path or an existing non-empty directory
- **THEN** it SHALL fail without overwriting existing content

#### Scenario: Scaffold is created

- **WHEN** init succeeds
- **THEN** it SHALL write a package configured as a private module app
- **AND** it SHALL write app context files `app/SOUL.md`, `app/WORLD.md`, and `app/DESCRIPTION.md`
- **AND** it SHALL create `app/skills` and `app/plugins`
- **AND** it SHALL write server, Nitro, Vite, Vercel, GitHub CI, `.gitignore`, and `.env.example` files
- **AND** scaffolded package scripts SHALL include `dev`, `check`, and `build`
- **AND** the scaffolded build script SHALL run `junior snapshot create` before the app build

### Requirement: Check Command

`junior check [dir]` SHALL validate Junior app, plugin, skill, and package configuration.

#### Scenario: Validation root is missing

- **WHEN** the target validation root does not exist or is not a directory
- **THEN** `junior check` SHALL fail with a validation-root error

#### Scenario: App files are present

- **WHEN** the app directory contains Junior app markers
- **THEN** `junior check` SHALL validate supported app context files
- **AND** it SHALL report the removed `ABOUT.md` file as an error
- **AND** it SHALL report missing `SOUL.md`, `WORLD.md`, or `DESCRIPTION.md` as warnings

#### Scenario: Local plugin manifests are present

- **WHEN** plugin manifests exist under `app/plugins/*/plugin.yaml`
- **THEN** `junior check` SHALL parse them through the plugin manifest parser
- **AND** it SHALL detect duplicate local plugin names and duplicate local provider domains

#### Scenario: Packaged plugin content is installed

- **WHEN** package dependencies contain installed packages with provider plugin or skill content
- **THEN** `junior check` SHALL validate packaged plugin manifests and packaged skills
- **AND** packaged duplicate plugin names/domains SHALL be checked separately from app-local duplicates

#### Scenario: Skill directories are present

- **WHEN** app-local, local-plugin, packaged-plugin, or packaged standalone skill directories are present
- **THEN** `junior check` SHALL parse each `SKILL.md`
- **AND** it SHALL detect duplicate skill names within the relevant app/local or packaged namespace
- **AND** it SHALL reject deprecated or harness-specific skill mechanics enforced by the skill parser/checker

#### Scenario: Removed app config is used

- **WHEN** app source uses removed `pluginPackages` configuration
- **THEN** `junior check` SHALL fail and instruct the operator to use `plugins: { packages: [...] }`

#### Scenario: Config defaults reference unknown keys

- **WHEN** app source declares `configDefaults` keys that are not registered by loaded plugin manifests
- **THEN** `junior check` SHALL fail with the unknown config key

#### Scenario: Official package versions differ

- **WHEN** an installed or declared official provider package version differs from `@sentry/junior`
- **THEN** `junior check` SHALL emit a warning
- **AND** the warning alone SHALL NOT fail validation

#### Scenario: Validation has errors

- **WHEN** one or more validation errors are found
- **THEN** `junior check` SHALL print each error
- **AND** it SHALL throw a summary validation failure

#### Scenario: Validation has only warnings or passes cleanly

- **WHEN** validation has no errors
- **THEN** `junior check` SHALL finish successfully
- **AND** it SHALL print a summary with the number of plugin manifests and skill directories checked

### Requirement: Snapshot Create Command

`junior snapshot create` SHALL warm sandbox runtime dependency snapshots for enabled provider packages.

#### Scenario: Snapshot creation is skipped

- **WHEN** `JUNIOR_SKIP_SNAPSHOT=1`
- **THEN** `junior snapshot create` SHALL log that snapshot creation was skipped
- **AND** it SHALL NOT resolve or build a runtime dependency snapshot

#### Scenario: Snapshot creation runs

- **WHEN** snapshot creation is not skipped
- **THEN** it SHALL collect loaded plugin providers, runtime dependencies, and runtime postinstall commands from the plugin registry
- **AND** it SHALL log the snapshot input summary before resolving the snapshot
- **AND** it SHALL resolve the runtime dependency snapshot using the default runtime and timeout configured by the CLI
- **AND** it SHALL log cache/build outcome metadata after completion
- **AND** it SHALL disconnect state adapters before returning

#### Scenario: Snapshot resolver fails

- **WHEN** runtime dependency snapshot resolution fails
- **THEN** `junior snapshot create` SHALL rethrow the resolver error after cleanup

### Requirement: CLI Output Compatibility

Junior CLI SHALL keep automation-relevant output stable while allowing human formatting to evolve.

#### Scenario: Automation consumes command outcomes

- **WHEN** scripts call the CLI
- **THEN** they SHALL rely on exit code, command availability, documented files, validation success/failure, and summary/error messages
- **AND** they SHALL NOT rely on color codes, tree drawing, or decorative status symbols

#### Scenario: Terminal does not support color

- **WHEN** `NO_COLOR` is set or the output stream does not support color
- **THEN** `junior check` SHALL avoid emitting color control sequences

### Requirement: CLI Verification

CLI changes SHALL be verified at the narrowest deterministic layer.

#### Scenario: Command dispatch changes

- **WHEN** supported command forms, usage, or handler routing change
- **THEN** unit tests SHALL cover valid and invalid argv forms

#### Scenario: Scaffold or validation changes

- **WHEN** `init` or `check` behavior changes
- **THEN** unit tests SHALL cover generated files, refusal modes, validation scope, errors, and warnings

#### Scenario: Snapshot warmup changes

- **WHEN** snapshot CLI behavior changes
- **THEN** unit tests SHALL cover dependency input collection, skip behavior, resolver options, progress/output summaries, and failure propagation

#### Scenario: Package bin loading changes

- **WHEN** the bin wrapper or CLI build entries change
- **THEN** tests SHALL verify every dynamically loaded CLI module is emitted by the package build
