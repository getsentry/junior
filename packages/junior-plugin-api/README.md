# @sentry/junior-plugin-api

This package defines the public contract between Junior and code plugins. The
exported TypeScript types and runtime validators are authoritative.

## Registration

Use `defineJuniorPlugin({ manifest, hooks, tasks, cli, model })`. A plugin name
is a lowercase identifier and is unique within the enabled app plugin set.

A plugin may instead be a declarative `plugin.yaml` package when it has no
host-executed hooks. Do not combine an inline manifest with a second YAML
definition for the same plugin.

## Manifest

The manifest declares runtime metadata such as:

- plugin identity and description;
- skill roots and MCP tool sources;
- provider domains, grants, OAuth, API-header transformations, and safe command
  environment placeholders;
- runtime dependencies and snapshot installation steps;
- configuration fields.

Manifest values are validated before runtime activation. Secret deployment
values remain host-only; sandbox-exposed command environment must be explicitly
safe.

## Hooks

Plugins may contribute tools, prompt messages, lifecycle work, operational
reports, migrations, and other typed hook surfaces exported by this package.

- Hook context carries the active source, actor, conversation, plugin metadata,
  database, logging, and only the host capabilities required by that hook.
- Prompt hooks return bounded structured prompt messages rather than mutate the
  core prompt.
- Tool hooks return model-visible schemas aligned with their executor inputs.
- Host-owned structured model and embedding calls do not expose provider
  credentials to plugins.

## Durable Work

- Heartbeat hooks perform bounded periodic maintenance and must be safe to run
  repeatedly.
- Background tasks are registered by name, receive validated parameters, and
  execute through the host queue/callback lifecycle.
- `ctx.agent.dispatch` creates durable agent work with an explicit actor,
  destination, source, metadata, and idempotency identity.
- Delegated credential subjects declare the narrow action that authorized them.
  Core owns runtime bindings; scheduler task subjects are accepted only from the
  scheduler plugin and are bound to the exact task id.
- Completed dispatch and task projections are durable plugin inputs, not an
  invitation to inspect unrestricted conversation state.

## Database

- Packaged migrations create plugin-owned tables through the host migration
  runner.
- Generate migration artifacts from the package schema; do not hand-maintain a
  second schema contract.
- Runtime hooks and CLI actions use host-provided `ctx.db`.
- Migrations are expand-first, deterministic, ordered by plugin name, and safe
  to retry. A failure blocks upgrade rather than partially enabling the plugin.
- Cross-plugin or core-table access is a review boundary for trusted app code;
  introduce a facade only when a concrete security or lifecycle boundary
  requires it.

## CLI

Code plugins may register one namespaced host CLI command with one or more
subcommands. Core command names win. Actions use the host action wrapper and
receive plugin metadata, configuration, database, safe output writers, and
logging—not model, Slack, sandbox, or provider credential context.

## Security

Plugins and skills follow `../../policies/security.md`,
`../../policies/data-redaction.md`, and
`../../policies/provider-boundaries.md`. Skills explain capability use; they do
not bootstrap runtimes or credentials.
