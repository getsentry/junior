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

## Host Ownership

- Validate names, manifests, duplicate registrations, and capability conflicts
  before serving traffic.
- The host owns credential brokering, SQL connection resolution, queue signing,
  task callbacks, model/embedder access, logging, and lifecycle invocation.
- Plugin hooks receive bounded invocation context and app-owned capabilities.
- Plugin-specific prompt text and tools enter the model only through registered
  hooks, skills, or MCP discovery.
- Plugin failures propagate through the owning hook, task, CLI, migration, or
  request boundary; do not silently disable part of a plugin.

The public contract and authoring guidance live in
`packages/junior-plugin-api/README.md`.
