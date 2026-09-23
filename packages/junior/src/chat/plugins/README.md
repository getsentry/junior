# Plugin Host Runtime

This directory loads explicitly configured plugins and adapts their public
`@sentry/junior-plugin-api` registrations into Junior runtime capabilities.

## Discovery

- Apps provide one explicit plugin set through `defineJuniorPlugins(...)`.
- Declarative packages use `plugin.yaml`; code plugins use an inline manifest
  and `defineJuniorPlugin(...)`.
- One plugin has one definition source. Do not split its identity or runtime
  metadata across YAML and JavaScript.
- Runtime does not scan dependencies or arbitrary filesystem paths for plugins.

## Core Features

- Core features such as Briefs register through the same runtime contract as
  code plugins. `core-features.ts` installs them; `agent-hooks.ts` serves core
  features and plugins together through `getRegistrations()`.
- Core features never enter plugin or package discovery. Their names are
  reserved, and `validatePlugins` rejects a plugin that claims one.
- `chat/app/core-features.ts` builds the core feature list from app options.
  Every core feature is always present so its stored events keep rendering; a
  disabled feature contributes only its event definitions.

## Host Ownership

- Validate names, manifests, duplicate registrations, and capability conflicts
  before serving traffic.
- The host owns credential brokering, SQL connection resolution, queue signing,
  task callbacks, model/embedder access, logging, and lifecycle invocation.
- Plugin hooks receive bounded invocation context and app-owned capabilities.
- Plugin background tasks receive a conversation-bound event writer. It accepts
  only definitions registered by that plugin; core owns namespace binding,
  durable ordering, and read-time transcript projection.
- Plugin-specific prompt text and tools enter the model only through registered
  hooks, skills, or MCP discovery.
- Plugin failures propagate through the owning hook, task, CLI, migration, or
  request boundary; do not silently disable part of a plugin.

The public contract and authoring guidance live in
`packages/junior-plugin-api/README.md`.
