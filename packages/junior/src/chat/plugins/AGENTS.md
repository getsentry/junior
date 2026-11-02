# Plugin Host Runtime

This module loads the configured plugins and adapts their
`@sentry/junior-plugin-api` registrations into runtime capabilities. The public
contract is in `packages/junior-plugin-api/README.md`.

## Invariants

- Apps give one explicit plugin set through `defineJuniorPlugins(...)`. Do not
  scan dependencies or file paths for plugins.
- One plugin has one definition source: `plugin.yaml` or an inline manifest.
  Do not split it across YAML and JavaScript.
- Validate names, manifests, duplicates, and capability conflicts before you
  serve traffic.
- The host owns credentials, SQL connections, queue signing, task callbacks,
  model access, logging, and lifecycle calls. Plugins get bounded context.
- A plugin event writer accepts only definitions that the same plugin
  registered. Core binds the namespace and the order.
- Plugin prompt text and tools reach the model only through registered hooks,
  skills, or MCP discovery.
- Plugin failures reach the owning boundary. Do not silently disable part of a
  plugin.
