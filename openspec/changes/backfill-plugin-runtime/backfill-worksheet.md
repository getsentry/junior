# Backfill Worksheet: `plugin-runtime`

## Scope

- Capability: Plugin runtime
- Change: `backfill-plugin-runtime`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/plugin-runtime.md` plus `openspec/specs/plugin-runtime/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/plugin.md`: high-level plugin architecture and ownership boundaries.
- `specs/plugin-runtime.md`: current prose runtime contract.
- `specs/plugin-manifest.md`: manifest syntax and validation.
- `specs/credential-injection.md`: provider broker and credential lease consumption.
- `specs/oauth-flows.md`: OAuth config consumption and callback routing.
- `specs/mcp-tool-runtime.md`: MCP activation and tool calls.
- `specs/skill-runtime.md`: skill discovery/loading behavior.
- `specs/trusted-plugin-heartbeat.md` and `specs/trusted-plugin-dispatch.md`: trusted plugin hook contracts.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior/src/app.ts`: createApp plugin config selection, trusted plugin registration, build/env config fallback, validation, rollback.
- `packages/junior/src/build/virtual-config.ts`: build-time plugin config injection.
- `packages/junior/src/nitro.ts`: plugin config wiring into Nitro.
- `packages/junior/src/chat/plugins/registry.ts`: runtime registry, source signatures, loading, accessors, broker creation.
- `packages/junior/src/chat/plugins/package-discovery.ts`: explicit package discovery.
- `packages/junior/src/chat/plugins/agent-hooks.ts`: trusted app plugin validation, tool collection, sandbox/tool lifecycle hooks.
- `packages/junior/src/chat/skills.ts`: plugin skill discovery, ownership verification, runtime-boundary injection.
- `packages/junior/src/chat/capabilities/catalog.ts`: capability catalog from plugin registry.
- `packages/junior/src/chat/capabilities/factory.ts`: broker factory consumption.
- `packages/junior/src/chat/mcp/tool-manager.ts`: manifest-configured MCP provider consumption.
- `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`: runtime dependency/postinstall consumption.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/app-config.test.ts`
  - `packages/junior/tests/unit/config/package-discovery.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
  - `packages/junior/tests/unit/skills/skills.test.ts`
  - `packages/junior/tests/unit/skills-plugin-provider.test.ts`
  - `packages/junior/tests/unit/capabilities/catalog.test.ts`
  - `packages/junior/tests/unit/plugins/agent-hooks.test.ts`
  - `packages/junior/tests/unit/runtime/runtime-dependency-snapshots.test.ts`
- Integration:
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
  - `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/sandbox-egress-proxy.test.ts`
- Evals:
  - Provider workflow evals that require packaged plugins and skills.

## Prior Art

- Package managers rely on declared package metadata and explicit dependency resolution rather than arbitrary package scanning.
- Agent skill systems treat skill files as model-facing context; they do not make skill text the authority for host runtime setup.
- MCP separates configured transport/client behavior from tool listing and tool invocation. A configured server is not equivalent to a connected provider with an authoritative tool catalog.
- Trusted extension hooks should be registered by host application code and receive narrow capability objects rather than global application internals.

Sources:

- npm `package.json` docs: https://docs.npmjs.com/files/package.json/
- Anthropic Claude Code skills docs: https://docs.anthropic.com/en/docs/claude-code/skills
- MCP specification: https://modelcontextprotocol.io/specification/2025-06-18

## Implemented Behavior

- Behavior that code currently enforces:
  - Plugin packages are only discovered when explicitly configured.
  - Configured packages must be valid package names, resolvable, and contain plugin/skill content.
  - `createApp` supports either `PluginConfig` or `JuniorPlugin[]`; trusted plugin arrays bypass legacy env plugin-package fallback.
  - Trusted plugin package config merges with build-time plugin config.
  - Failed plugin/config-default validation rolls back previous plugin config, trusted plugins, and defaults.
  - Registry rebuilds from a catalog signature containing manifest roots, packaged skill roots, package names, and plugin config.
  - Registry publishes provider definitions, MCP providers, OAuth config, skill roots, runtime dependencies, runtime postinstall commands, and broker factories.
  - Capability catalog refreshes when plugin catalog signature changes and returns defensive copies.
  - Plugin skills are discovered from plugin skill roots, tagged by owning provider, and re-owned at load time.
  - Plugin skill bodies receive a host-owned runtime boundary derived from manifest surfaces.
  - Broker creation routes to API headers, OAuth bearer, or GitHub App brokers from manifest declarations.
  - Trusted plugins validate names, duplicate names, legacy state prefixes, tool names, duplicate tools, hook denials, and sandbox prepare contexts.
  - MCP providers are exposed by manifest metadata and consumed lazily by the MCP runtime.
- Behavior that tests currently verify:
  - Empty package discovery, explicit package discovery, package failure modes, symlink/ancestor package resolution.
  - App config fallback/rollback and trusted plugin validation.
  - Registry reload after packaged content changes.
  - Plugin skill discovery, config-only plugin skills, runtime-boundary injection, stale frontmatter validation.
  - Capability catalog refresh and defensive copy behavior.
  - Trusted hook validation and lifecycle hooks.
- Behavior that appears accidental or weakly enforced:
  - Registry and trusted plugin state are process globals rather than app-scoped runtime state.
  - Skill discovery cache behavior is TTL/root-key based and only indirectly tied to catalog signature.
  - Some unreadable local roots warn and continue; configured package failures throw.
  - Public package compatibility/versioning is not defined.
  - Trusted tool hooks are in this runtime surface, but durable heartbeat/dispatch specs own parts of trusted plugin behavior.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Plugin discovery is explicit.
  - Effective manifests are the sole source of plugin registry metadata.
  - Failed catalog validation must not expose partial active registry state.
  - Skills may describe plugin usage but cannot own runtime setup.
  - Trusted plugin code must be app-registered and validated before mutation.
  - MCP is connected lazily by MCP runtime, not registry load.
- Behavior that should remain implementation detail:
  - Registry signature JSON shape.
  - Exact skill discovery cache TTL.
  - Exact logging event payloads.
  - Exact order of successful plugin loaded logs.
- Behavior that should be non-goal:
  - Plugin package installation.
  - Provider-specific auth/command/API details.
  - OAuth token handling.
  - MCP tool execution internals.
  - Trusted heartbeat/dispatch details beyond registration surface.

## Undefined Behavior / Open Questions

| Question                                                   | Evidence                                                                     | Options                                                           | Recommendation                                                                 | Status |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| Should plugin registry state be app-scoped?                | `setPluginConfig` and `setAgentPlugins` mutate process globals.              | Keep global, app-scoped runtime, or request-scoped injection.     | Consider app-scoped runtime before multiple apps per process become supported. | open   |
| Should skill cache key include plugin catalog signature?   | Cache key is roots-based with TTL; registry can change via config signature. | Keep TTL, include signature, or invalidate on setPluginConfig.    | Include catalog signature if plugin reload bugs recur.                         | open   |
| Should unreadable local plugin roots fail startup?         | Registry warns and continues for unreadable roots.                           | Warn, fail always, or fail only configured roots.                 | Fail configured roots; warn optional app roots.                                | open   |
| What compatibility is promised for public plugin packages? | No manifest version or package compatibility policy here.                    | Semver package policy, manifest versioning, or experimental only. | Define under provider-packages/release packaging.                              | open   |
| Should trusted hook contracts live here?                   | `agent-hooks.ts` is runtime, but heartbeat/dispatch have dedicated specs.    | Keep shared registration here, split hook behavior.               | Keep registration here; detailed hooks in trusted specs.                       | open   |

## OpenSpec Requirements Draft

| Requirement                        | Scenarios                                                                  | Source Evidence                  | Notes                         |
| ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------- | ----------------------------- |
| Explicit plugin discovery          | none configured, configured, missing, no content, unreadable root          | package discovery/registry tests | No node_modules scanning.     |
| App plugin configuration lifecycle | PluginConfig, trusted array, env fallback, rollback                        | app-config tests                 | Process global today.         |
| Deterministic registry loading     | signature, cache, rebuild, root/child manifests, no partial active state   | registry tests/code              | External all-or-nothing.      |
| Registry public surfaces           | providers, OAuth, skill roots, runtime deps, unknowns                      | registry/code/tests              | Manifest-derived.             |
| Capability catalog integration     | registered capability, signature refresh, defensive copies                 | catalog tests                    | Channel config consumes keys. |
| Plugin skill discovery/loading     | provider tag, config-only, boundary, forged metadata, load-time validation | skills tests                     | Skill-runtime overlap.        |
| Broker creation routing            | unknown, API headers, OAuth bearer, GitHub App, no credentials             | registry/broker tests            | Detailed auth in plugin-auth. |
| MCP provider exposure              | list, no startup connect, runtime activation                               | registry/MCP tests               | MCP runtime owns connection.  |
| Trusted app plugin registration    | name, duplicates, state prefix, tools, denials, sandbox hook               | agent-hooks/app tests            | Hook details split.           |
| Security boundaries                | skill prose, secrets, prompt plugin-agnostic                               | plugin specs/prompt tests        | Host-owned runtime.           |
| Verification taxonomy              | unit, skill tests, integration, evals                                      | testing spec                     | Layer map.                    |

## Migration Notes

- Canonical spec updates:
  - Consolidate `specs/plugin-runtime.md` into this OpenSpec capability after review.
  - Keep `specs/plugin.md` as the high-level architecture map or fold it into a short index/rationale doc.
- Index/pointer updates:
  - Existing `specs/index.md` and root `AGENTS.md` already list plugin specs; add OpenSpec capability pointer after acceptance.
- Superseded content:
  - Move manifest syntax requirements to `plugin-manifest`.
  - Move trusted heartbeat/dispatch specifics to their dedicated specs.
  - Move auth pause/token behavior to `oauth-flows`, `credential-injection`, and `plugin-auth`.
- Test/eval taxonomy changes:
  - Keep registry/discovery in unit tests.
  - Keep Slack/runtime provider flows in integration tests.
  - Keep provider workflow quality in evals.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-plugin-runtime' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: app-scoped registry state, skill cache invalidation, unreadable local root policy, package compatibility, trusted hook split.
