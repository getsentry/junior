# Design: `plugin-runtime` Baseline Backfill

## Sources Reviewed

- `specs/plugin.md`
- `specs/plugin-runtime.md`
- `specs/plugin-manifest.md`
- `packages/junior/src/app.ts`
- `packages/junior/src/chat/plugins/registry.ts`
- `packages/junior/src/chat/plugins/package-discovery.ts`
- `packages/junior/src/chat/plugins/types.ts`
- `packages/junior/src/chat/plugins/agent-hooks.ts`
- `packages/junior/src/chat/skills.ts`
- `packages/junior/src/chat/capabilities/catalog.ts`
- `packages/junior/src/chat/capabilities/factory.ts`
- `packages/junior/src/chat/mcp/tool-manager.ts`
- `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`
- `packages/junior/tests/unit/app-config.test.ts`
- `packages/junior/tests/unit/config/package-discovery.test.ts`
- `packages/junior/tests/unit/plugins/plugin-registry.test.ts`
- `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
- `packages/junior/tests/unit/skills/skills.test.ts`
- `packages/junior/tests/unit/capabilities/catalog.test.ts`
- `packages/junior/tests/unit/plugins/agent-hooks.test.ts`
- `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
- `packages/junior/tests/integration/sandbox-egress-proxy.test.ts`
- npm package manifest docs: https://docs.npmjs.com/files/package.json/
- MCP specification: https://modelcontextprotocol.io/specification/2025-06-18
- Agent Skills format prior art: https://docs.anthropic.com/en/docs/claude-code/skills

## Prior-Art Interpretation

- Plugin discovery should be explicit. Package managers use declared dependencies and package metadata rather than scanning arbitrary filesystem content; Junior follows that model by requiring configured plugin package names.
- Skills are model-facing instructions, not runtime authority. Agent skill prior art treats skills as loadable procedural/context content; Junior adds a runtime boundary for plugin-owned setup so skills cannot smuggle credential or installation behavior into prompt text.
- MCP provider connection should remain lazy and runtime-owned. The manifest and registry can expose configured providers, but MCP connection, authorization, tool listing, and tool execution belong to the MCP runtime.
- Trusted app plugins are host code. They require explicit registration through app configuration and narrow hook contexts; they are not activated by YAML alone.

## Design Decisions

### Explicit Catalog Only

The runtime uses local app plugin roots and configured package names. It must not scan `node_modules`, dependency lists, arbitrary paths, or skill prose to infer plugins.

### All-Or-Nothing Publication

Registry loading may build a temporary state incrementally, but externally visible registry state must only be replaced after the new catalog validates. Failed reloads should leave the previous known-good plugin state and app configuration intact.

### Runtime Surfaces Are Derived From Effective Manifests

Capability providers, OAuth config, credential brokers, MCP provider lists, runtime dependencies, postinstall commands, plugin skill roots, and provider-domain ownership all come from effective parsed manifests after `PluginConfig` overrides.

### Plugin Skills Are Re-Owned At Load Time

Skill discovery can attach plugin metadata based on path, but `loadSkillsByName` must re-resolve the parent plugin from the current skill path and current manifest. Stale or forged plugin metadata must fail before a skill body is handed to the agent.

### Trusted Hooks Are App-Code Plugins

Trusted app plugin hooks are registered through `createApp({ plugins: JuniorPlugin[] })`, validated before mutating global state, sorted deterministically, and exposed through narrow contexts. YAML manifests may configure bundled package content, but trusted code hooks are not declared by `plugin.yaml`.

## Risks

- Registry state and trusted plugins are process globals. Tests rely on rollback helpers, but the product contract should stay focused on app startup/reload behavior, not test-only mutation.
- Skill discovery cache invalidation depends on roots/signature and TTL behavior; exact TTL should remain implementation detail.
- Startup validation may be skipped when no plugin catalog and no config defaults are configured; this is pragmatic but means local invalid plugin files outside discovered roots remain ignored.
- Plugin package compatibility/versioning is not defined here; provider package specs and release packaging need to own that.

## Verification Approach

- Unit tests own deterministic discovery, registry loading, accessors, app config rollback, skill ownership, capability catalog refresh, and trusted hook validation.
- Integration tests own runtime consumption across Slack/OAuth/MCP/sandbox/credential paths.
- Evals own user-visible behavior from available plugin skills/tools, not registry mechanics.
