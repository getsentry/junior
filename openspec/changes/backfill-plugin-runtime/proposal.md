# Backfill `plugin-runtime`

## Why

Plugin runtime behavior decides which local and packaged plugin content becomes available to the agent, the capability catalog, credential brokers, OAuth routes, MCP providers, sandbox snapshot inputs, trusted hooks, and skill loading. Existing behavior is documented in `specs/plugin.md` and `specs/plugin-runtime.md`, but the normative requirements are still prose and overlap with manifest, credential, OAuth, MCP, and trusted-plugin specs.

This baseline separates runtime loading and exposure from manifest syntax and provider-specific implementation.

## What

- Backfill an OpenSpec capability for `plugin-runtime`.
- Inventory plugin architecture/runtime specs, registry, app config, package discovery, skill loading, capability catalog, broker creation, runtime dependency accessors, trusted app plugin hooks, and tests.
- Define normative requirements for:
  - explicit plugin discovery
  - app plugin configuration and rollback
  - deterministic registry loading and all-or-nothing publication
  - registry public surfaces and defensive copies
  - capability catalog integration
  - plugin skill discovery and runtime-boundary injection
  - broker creation routing
  - OAuth/MCP/runtime dependency metadata exposure
  - trusted app plugin registration and hook exposure
  - startup/check validation
  - security boundaries and verification taxonomy
- Record undefined behavior without implementing changes.

## Impact

- Canonical capability: `plugin-runtime`
- Existing prose inputs: `specs/plugin.md`, `specs/plugin-runtime.md`
- Related capabilities:
  - `plugin-manifest`
  - `credential-injection`
  - `oauth-flows`
  - `mcp-tool-runtime`
  - `skill-runtime`
  - `trusted-plugin-heartbeat`
  - `trusted-plugin-dispatch`
  - `channel-configuration`
  - `sandbox-tools`

## Non-Goals

- Redefining manifest field syntax.
- Implementing plugin package installation or marketplace behavior.
- Defining OAuth token exchange, credential lease injection, or MCP tool invocation internals.
- Defining trusted heartbeat/dispatch hook contracts in detail.
- Changing app/plugin configuration behavior.
