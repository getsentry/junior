# Plugin CLI Spec

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-26

## Purpose

Define the future shape for plugins to contribute host CLI commands
without making those commands model-visible tools or sandbox commands.

## Scope

- Plugin-owned CLI command registration.
- Command discovery and conflict rules.
- Command context, IO, database access, task enqueueing, and admin boundaries.
- Security rules for local/operator execution.

## Non-Goals

- Letting `plugin.yaml` register executable CLI code.
- Exposing plugin CLI commands to the model.
- Running plugin CLI commands inside the agent sandbox.
- Replacing `junior chat`, `junior init`, `junior check`, `junior upgrade`, or
  other core commands.

## Contracts

### Command Ownership

Plugin CLI commands are app-owned runtime code registered through app-code plugin
registration, not declarative `plugin.yaml`.

The plugin shape is:

```ts
defineJuniorPlugin({
  manifest,
  cli: {
    commands: [
      {
        name: "memory",
        summary: "Inspect and repair Junior memory state",
        configure(command, junior) {
          command
            .command("search")
            .argument("[query...]", "Search query")
            .requiredOption("--scope <scope>", "Memory scope")
            .requiredOption("--scope-key <key>", "Scope key")
            .action(
              junior.action(async (ctx, queryParts, options) => {
                // Plugin-owned command behavior.
              }),
            );
        },
      },
    ],
  },
});
```

Commands are explicitly registered by enabled code plugins and run with a
narrow host-provided context. Junior owns the root CLI program and creates the
top-level `Command` instance for each plugin command. Plugins may configure
subcommands, arguments, options, help text, and actions under that command, but
they do not receive or mutate the root program.

CLI bootstrap imports the configured app-code plugin module before dispatching
app-scoped commands, validates all plugin CLI command names against core command
names and other enabled plugins, and then dispatches matching plugin commands.
`junior init` remains independent because it can run before an app plugin module
exists.

### Command Namespace

Plugin command names must be stable, lowercase, and unique across enabled
plugins and core commands.

Core command names win. If a plugin command conflicts with a core command or
another enabled plugin command, startup or CLI bootstrap must fail before
dispatching the command.

V1 should prefer one top-level command per plugin, such as:

```txt
junior memory ...
```

Subcommands below that namespace are plugin-owned. Plugin CLI commands should
use subcommands rather than adding many top-level verbs. A top-level plugin
command may not be renamed during configuration, and top-level aliases are not
allowed because they occupy the host-owned root namespace. Junior validates the
declared command name before attaching it to the root CLI.

### CLI Framework

Junior uses Commander for plugin CLI parsing and help rendering. Commander is
an intentional part of the plugin CLI surface: plugin command configuration
receives a Commander `Command` instance scoped to the plugin's declared
top-level namespace. Core CLI commands may continue to use host-owned dispatch
internals as long as plugin commands keep the Commander contract.

Plugin code should use Commander-native subcommands, arguments, options,
choices, generated help, and async actions. Plugin actions must be wrapped with
the Junior-provided action helper so the host can inject the plugin CLI context
and normalize exit codes.

The root command remains host-owned:

- plugins must not attach commands to the root program
- plugins must not call `process.exit`
- plugins must not bypass the Junior action wrapper for privileged behavior
- plugins may split subcommand configuration across files and compose them from
  their plugin-owned CLI module

### Command Context

Plugin CLI command handlers may receive:

- Commander-parsed arguments and options for the plugin subcommand
- stdout/stderr writers
- safe logger
- plugin metadata
- plugin config
- `ctx.db` from the standard plugin hook context
- background task enqueue capability for repair/backfill work
- host embedding/model capabilities only when explicitly declared by the
  plugin's command contract

Handlers must not receive:

- raw Slack clients or tokens
- raw HTTP request objects
- provider credentials
- model-visible tool contexts
- sandbox command handles
- cross-plugin mutable state

### Admin Boundary

Plugin CLI commands are operator/admin surfaces. They do not run as a Slack
actor or local chat actor unless the command explicitly accepts a
context selector and maps it through the same identity rules as runtime code.

For production deployments, remote or hosted admin commands require a separate
admin authentication story before implementation. Local CLI access to a
configured database is not by itself a user-facing authorization model.

### Output Rules

Plugin CLI commands must be scriptable and redaction-aware:

1. Default output should avoid raw private content when counts, ids, status, or
   metadata are enough.
2. Commands that print private content must require an explicit flag or
   subcommand.
3. Machine-readable output must not include secrets or provider credentials.
4. Errors must be concise and must not dump raw SQL parameters, provider
   payloads, prompt text, or private transcripts.

### Relationship To Model Tools

Plugin CLI commands are not model-visible tools. The agent cannot call them
through the tool registry, and skills must not instruct the model to use CLI
commands for privileged memory administration during a normal turn.

If an operation needs to be available to the model, expose it through the plugin
tool surface with context-bound schemas and model-safe output. If an operation
is administrative, expose it through CLI only.

## Verification

Required checks when implemented:

- plugin CLI command discovery is explicit and deterministic
- command conflicts fail before dispatch
- plugin commands configure only their host-created top-level namespace
- disabled plugins do not expose commands
- plugin commands cannot access another plugin's state unless core provides an
  explicit shared admin surface
- invalid arguments use generated usage/help and exit non-zero without side
  effects
- private content is omitted from default output

## Related Specs

- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-database.md`
- `./memory-plugin/admin.md`
- `./testing.md`
