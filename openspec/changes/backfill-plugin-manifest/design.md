# Design: `plugin-manifest` Baseline Backfill

## Sources Reviewed

- `specs/plugin-manifest.md`
- `packages/junior/src/chat/plugins/manifest.ts`
- `packages/junior/src/chat/plugins/types.ts`
- `packages/junior/src/chat/plugins/command-env.ts`
- `packages/junior/src/chat/plugins/registry.ts`
- `packages/junior/src/chat/plugins/package-discovery.ts`
- `packages/junior/src/cli/check.ts`
- `packages/junior/tests/unit/plugins/plugin-manifest-config.test.ts`
- `packages/junior/tests/unit/plugins/plugin-manifest-api-headers.test.ts`
- `packages/junior/tests/unit/plugins/plugin-registry.test.ts`
- `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
- `packages/junior/tests/unit/cli/check-cli.test.ts`
- npm package manifest docs: https://docs.npmjs.com/files/package.json/
- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- MCP 2025-06-18 spec and authorization docs:
  - https://modelcontextprotocol.io/specification/2025-06-18
  - https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

## Prior-Art Interpretation

- Package manifests should be declarative metadata that can be validated before runtime activation. npm package metadata is the closest packaging analogy: package identity and dependency declarations are data, while execution is mediated by the installer/runtime.
- OAuth configuration belongs in host/runtime configuration, not in model-visible prompt state. The manifest can declare endpoints and env-var names, but token exchange, token storage, and authorization interruptions belong to the OAuth/runtime specs.
- MCP provider declarations should be treated as constrained transport configuration. The manifest may declare a server URL, non-secret headers, and allowed tool names, while activation, auth challenges, tool discovery, and result conversion belong to the MCP runtime spec.
- Plugin manifests are also a security boundary. They identify provider domains and host environment variables that may receive credentials; they must not provide a path for arbitrary secret exfiltration into sandbox command environments.

## Design Decisions

### Manifest As Declarative Authority

`plugin.yaml` is the authority for plugin identity and declared integration surfaces. The registry should not infer provider domains, credentials, MCP endpoints, OAuth endpoints, or capabilities from skills, package names, README content, or runtime command output.

### Config Overrides Apply Before Validation

Install-level `PluginConfig.manifests` patches are part of the effective manifest. They apply before validation and duplicate checks so an installation can repair package-specific domains or disable optional declarations. The plugin name remains immutable because registry identity, package mapping, state keys, and provider names depend on it.

### Exact Provider Domain Ownership

Effective provider domains are exact hostnames, lowercased and globally unique across loaded plugins. Wildcard, path, and scheme matching are intentionally outside the current baseline because credential routing and egress policy require deterministic ownership.

### Environment Variables Are Declarations, Not Ambient Access

Manifest env vars must be declared explicitly before placeholder use. Secret-bearing variables may be referenced by credential, OAuth, and API-header declarations but must not be projected into sandbox command env. Command env may only use non-secret default-backed placeholders at manifest load time or defaultless placeholders resolved later by the host command-env builder.

### Runtime Dependency Declarations Stay Constrained

Runtime dependencies and post-install commands are manifest data for the snapshot/runtime builder. They are intentionally constrained to known package/url shapes and simple executable commands. This spec does not define dependency installation order, cache invalidation, or snapshot persistence; those belong to plugin runtime or sandbox specs.

### MCP And OAuth Are Declarations Only

The manifest declares enough MCP/OAuth data for runtime code to create providers. It does not define callback state, token storage, auth pause behavior, MCP session lifecycles, tool result conversion, or Slack UX.

## Risks

- The parser currently allows unknown root fields through the raw schema path; the baseline records this as undefined rather than silently blessing long-term compatibility.
- Some security-sensitive fields allow literal static values today, notably plugin-level API headers and MCP headers. The spec should call out the intended secret boundary and leave literal-value tightening as a follow-up.
- The prose spec says system URL runtime dependencies are HTTPS RPMs, while the parser enforces HTTPS plus SHA-256 but does not enforce the `.rpm` suffix.
- Config-key duplicate behavior is weakly enforced compared with capability duplicate behavior.

## Verification Approach

- Unit tests own deterministic manifest parsing, patching, env-var expansion, validation failures, duplicate detection, and package discovery.
- CLI tests own local app/package validation output and failure behavior.
- Integration tests are only needed when manifest declarations are consumed by real runtime wiring such as plugin brokers, OAuth, MCP activation, sandbox dependency installation, or credential injection.
- Evals are not the primary layer for manifest syntax. They only cover user-visible behavior that depends on a plugin being available and correctly described to the agent.
