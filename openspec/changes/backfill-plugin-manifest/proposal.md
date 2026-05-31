# Backfill `plugin-manifest`

## Why

Plugin manifests are the declarative contract that turns a packaged or local plugin into Junior runtime behavior. They declare provider identity, capabilities, configuration keys, provider domains, credential requirements, OAuth setup, API header injection, MCP endpoints, runtime dependencies, post-install commands, and target configuration. Today that behavior is spread across `specs/plugin-manifest.md`, the manifest parser, plugin registry, package discovery, CLI validation, and tests.

The baseline OpenSpec needs to make the manifest contract explicit before plugin runtime, credential, OAuth, MCP, provider package, and CLI specs depend on it.

## What

- Backfill an OpenSpec capability for `plugin-manifest`.
- Inventory the existing prose spec, parser, type contracts, registry/package discovery paths, CLI validation, and tests.
- Compare the local design against prior art from package manifests, OAuth, MCP, and plugin-security patterns.
- Define normative requirements for:
  - manifest identity and YAML parsing
  - `PluginConfig` manifest overrides
  - capability/config-key normalization
  - provider domain ownership
  - environment variable declaration and placeholder expansion
  - API header declarations
  - credential declarations
  - OAuth declarations
  - runtime dependencies and post-install commands
  - MCP declarations
  - target declarations
  - package discovery and registry validation
  - CLI/check validation ownership
  - verification taxonomy
- Record undefined behavior and implementation gaps without resolving them in this backfill.

## Impact

- Canonical capability: `plugin-manifest`
- Existing prose input: `specs/plugin-manifest.md`
- Related capabilities:
  - `plugin-runtime`
  - `credential-injection`
  - `oauth-flows`
  - `mcp-tool-runtime`
  - `security-policy`
  - `cli`
  - `provider-packages`

## Non-Goals

- Changing manifest syntax or parser behavior.
- Implementing manifest versioning or compatibility guarantees.
- Defining plugin execution/runtime behavior beyond manifest declarations.
- Defining provider-specific API semantics.
- Freezing exact parser error strings except where tests intentionally rely on them.
