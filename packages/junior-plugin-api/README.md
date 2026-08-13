# @sentry/junior-plugin-api

This package defines the public contract between Junior and code plugins. The
exported TypeScript types and runtime validators are authoritative.

## Registration

Use
`defineJuniorPlugin({ manifest, hooks, tasks, cli, model, conversationEvents })`.
A plugin name is a lowercase identifier and is unique within the enabled app
plugin set.

Packages with JavaScript registration export one callable factory named
`<domain>Plugin`, such as `githubPlugin(options?)`. Do not use a public
`create<Domain>Plugin` alias or export a prebuilt registration. Call the factory
even when it accepts no options.

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
- configuration fields;
- signed-in user pages backed by core-owned discovery and read routes.

Manifest values are validated before runtime activation. Secret deployment
values remain host-only; sandbox-exposed command environment must be explicitly
safe.

## Hooks

Plugins may contribute tools, prompt messages, lifecycle work, operational
reports, and other typed hook surfaces exported by this package.

- Hook context carries the active source, actor, conversation, plugin metadata,
  database, logging, and only the host capabilities required by that hook.
- Prompt hooks return bounded structured prompt messages rather than mutate the
  core prompt.
- User prompt hooks for durable turns may emit registered structured events
  through `ctx.events` for auxiliary work completed while building context.
- Tool hooks return model-visible schemas aligned with their executor inputs.
- Tool registration hooks may use `ctx.sandbox` for plugin-owned workspace
  files and commands; Junior still owns sandbox lifecycle, cancellation,
  provider egress, and authorization recovery.
- Host-owned structured model and embedding calls do not expose provider
  credentials to plugins. Both return a best-effort provider cost estimate when
  one is available.
- Operational report and authenticated API hooks may aggregate `costUsd` from
  their own registered conversation events through `ctx.eventStats`. Core
  binds the plugin namespace and owns access to the conversation event log.
  Event `costUsd` is additive operation cost and must not duplicate cost
  already recorded in the conversation's agent model usage.
- Profile report hooks return the same bounded operational report content for
  one subject user on a person profile. Core owns viewer authorization,
  collection, sanitization, and browser rendering.
- Tool hooks may lazily resolve the active actor's canonical identity and linked
  user through `ctx.users.resolveActor()`.
- Authenticated API route hooks receive `ctx.users.resolve(email)` for lazy
  canonical user resolution. Routes that do not need personal ownership do not
  query identity storage.
- User page readers receive the canonical viewer `User` with linked identities.
  Plugins return bounded data and do not mount their own page routes or browser
  code.

## User Pages

Register signed-in pages through `userPages` beside `hooks`, `tasks`, and `cli`.
Each definition owns its navigation metadata and `read(ctx, input)` function,
so a page cannot be advertised without an implementation. List readers receive
validated search and cursor input and may return an opaque continuation cursor.
Set `navigation: "primary"` for a top-level dashboard navigation item. The
default `profile` placement keeps account-oriented pages in the signed-in user
menu. Junior always renders core System navigation after plugin pages.
Records may expose bounded `DELETE` actions inside their own authenticated
plugin API namespace. Core owns discovery, authentication, user resolution,
routing, response validation, rendering, confirmation, and query state.

## Durable Work

- Heartbeat hooks perform bounded periodic maintenance and must be safe to run
  repeatedly.
- Background tasks are registered by name, receive validated parameters, and
  execute through the host queue/callback lifecycle.
- Conversation-bound background tasks may emit registered structured events
  through `ctx.events`. Define each version with `defineConversationEvent()`;
  the host supplies the plugin namespace, conversation, turn, ordering, and
  timestamps without treating background work as new conversation activity.
  Event definitions return bounded transcript presentation data, while Junior
  owns browser rendering.
- `ctx.agent.dispatch` creates durable agent work with an explicit actor,
  destination, source, metadata, and idempotency identity.
- Dispatches may include compact `replyAttribution` for destination-visible
  context about what produced the reply. Core owns platform rendering; opaque
  dispatch metadata remains internal.
- Delegated credential subjects declare the narrow action that authorized them.
  Core owns runtime bindings; scheduler task subjects are accepted only from the
  scheduler plugin and are bound to the exact task id.
- Completed dispatch and task projections are durable plugin inputs, not an
  invitation to inspect unrestricted conversation state.

## Conversation Events

Register plugin-owned event definitions through `conversationEvents`. A
definition owns one local name, version, content schema, and `renderEvent()`
projection. A renderer may return `undefined` when an event should remain
durable without producing a transcript row. The active plugin context supplies
the namespace, so plugins cannot emit native events or impersonate another
plugin. The `junior` plugin name is reserved for host-owned native events.
Versions of the same event name share one operation idempotency identity,
so keep previous definitions registered when evolving an event. Stored events
remain durable when a plugin is removed, but normal transcript projection skips
definitions that are not currently registered.

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
