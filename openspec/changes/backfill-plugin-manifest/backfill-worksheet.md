# Backfill Worksheet: `plugin-manifest`

## Scope

- Capability: Plugin manifest
- Change: `backfill-plugin-manifest`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/plugin-manifest.md` plus `openspec/specs/plugin-manifest/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/plugin-manifest.md`: current prose contract for `plugin.yaml`.
- `specs/plugin.md`: broader plugin packaging and provider integration model.
- `specs/plugin-runtime.md`: runtime discovery/loading and MCP/provider behavior.
- `specs/credential-injection.md`: requester-bound provider credentials and sandbox credential projection.
- `specs/oauth-flows.md`: OAuth provider flow and Slack authorization UX.
- `specs/mcp-tool-runtime.md`: MCP provider activation and tool invocation behavior.
- `specs/security-policy.md`: secret and sandbox boundary constraints.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior/src/chat/plugins/manifest.ts`: YAML parsing, schema validation, `PluginConfig` patching, env-var placeholder handling, credentials, OAuth, API headers, runtime dependencies, MCP, and target normalization.
- `packages/junior/src/chat/plugins/types.ts`: manifest and plugin config type contracts.
- `packages/junior/src/chat/plugins/command-env.ts`: defaultless command-env placeholder resolution at sandbox command time.
- `packages/junior/src/chat/plugins/registry.ts`: local/package manifest discovery, duplicate plugin/capability/domain validation, plugin skill roots, registry reload signature, broker creation.
- `packages/junior/src/chat/plugins/package-discovery.ts`: configured npm package discovery and plugin package content validation.
- `packages/junior/src/cli/check.ts`: local and packaged manifest validation in the check CLI.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/plugins/plugin-manifest-config.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-manifest-api-headers.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-runtime-dependencies.test.ts`
  - `packages/junior/tests/unit/cli/check-cli.test.ts`
- Integration:
  - Runtime consumption tests under OAuth, credential injection, MCP, sandbox, and provider-package areas.
- Evals:
  - Provider workflow evals that assume packaged plugins expose tools/skills/capabilities.

## Prior Art

- npm package metadata establishes a package-manifest pattern: identity and dependency declarations are static data consumed by package managers and runtime tooling.
- OAuth 2.0 keeps authorization request construction, state, code exchange, and token handling in application runtime. A plugin manifest may declare endpoints and env-var names, but the runtime owns the flow.
- MCP defines the tool protocol and HTTP authorization model. A plugin manifest may configure a provider endpoint and tool allowlist, but MCP session lifecycle, auth challenges, tool discovery, and tool invocation are runtime concerns.
- Security-oriented plugin systems treat manifests as trust boundaries: they constrain where credentials can flow and reject ambiguous or executable-looking declarations before activation.

Sources:

- npm `package.json` docs: https://docs.npmjs.com/files/package.json/
- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- MCP specification: https://modelcontextprotocol.io/specification/2025-06-18
- MCP authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

## Implemented Behavior

- Behavior that code currently enforces:
  - Manifest identity requires lowercase kebab-case `name` and non-empty `description`.
  - `PluginConfig.manifests` applies before validation; name changes fail; `null` removes optional fields/map entries.
  - Capabilities and config keys are plugin-qualified.
  - Registry rejects duplicate plugin names, duplicate qualified capabilities, and duplicate effective provider domains.
  - Domains are exact lowercase hostnames; top-level domains require credentials or API headers; top-level API headers require domains.
  - `env-vars` keys are uppercase-style identifiers and only allow `default`.
  - API-header env refs must be declared and cannot have defaults.
  - `mcp.url` expands `${VAR}` from process env or env-var defaults and fails if unset without default.
  - `command-env` default-backed refs expand at manifest load, defaultless refs remain host-bound, and command env cannot reference API-header/OAuth/credential secret vars.
  - OAuth requires `oauth-bearer` credentials, HTTPS endpoints, supported token auth methods, and excludes runtime-owned authorize params.
  - Credential declarations support `oauth-bearer` and `github-app` with required env-var names and domains.
  - Runtime dependencies support npm, system package, and HTTPS system URL plus SHA-256 forms with deduplication.
  - Runtime postinstall allows constrained executable commands, optional args, and optional sudo.
  - MCP declarations require HTTP transport, HTTPS URL, allowed tools, and no Authorization header.
  - Target config keys must be declared in `config-keys`; target flags are validated.
  - Configured plugin packages must resolve to installed content containing plugin or skill content.
  - Registry reloads when roots, packaged content, or plugin config signature changes.
  - Check CLI validates local app plugins and packaged plugin manifests/skills.
- Behavior that tests currently verify:
  - Override patch/removal/name-change errors.
  - Package discovery, duplicate provider domains, duplicate plugin names, invalid credentials, runtime deps/postinstall, OAuth endpoint/header validation, MCP validation, env-var expansion, and CLI output.
- Behavior that appears accidental or weakly enforced:
  - Unknown root manifest fields are accepted by schema parsing but ignored by runtime.
  - Plugin-level API headers may contain literal values; env-var refs are validated when present.
  - MCP headers may contain static non-Authorization values.
  - Runtime system URL dependencies do not enforce an RPM suffix even though the prose spec says HTTPS RPM.
  - Duplicate config-key declarations inside one plugin are not rejected as strongly as duplicate capabilities.
  - No manifest schema version field exists.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Manifest declarations are the source of truth for plugin identity, domains, credentials, OAuth, MCP, target configuration, and runtime setup metadata.
  - Effective manifests include installation overrides before validation and duplicate checks.
  - Manifests must keep secret-bearing values host-bound and out of sandbox command env.
  - Domain ownership must be deterministic and exact.
  - Runtime behavior specs own how declarations are consumed.
- Behavior that should remain implementation detail:
  - Exact internal Zod schema structure.
  - Exact parser error text except where CLI or test contracts deliberately assert it.
  - Exact registry cache signature representation.
  - Exact ordering of validation errors.
- Behavior that should be non-goal:
  - Provider-specific API semantics.
  - Runtime credential issuance.
  - OAuth callback/resume behavior.
  - MCP tool execution behavior.
  - Plugin package publish policy.

## Undefined Behavior / Open Questions

| Question                                               | Evidence                                                                             | Options                                                                                        | Recommendation                                                                            | Status |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| Should unknown root fields be rejected?                | Parser schemas use passthrough behavior while runtime ignores unknown fields.        | Reject, ignore, warn, or reserve for forward compatibility.                                    | Decide before public manifest compatibility is promised.                                  | open   |
| Should plugin-level API header values be literal-safe? | Parser validates env refs when present but does not require env refs for all values. | Allow static non-secret headers, require env refs for all headers, or classify by header name. | Require env refs for secret-bearing headers; allow static content-type/workspace headers. | open   |
| Should MCP headers allow literal values?               | Parser allows static non-Authorization MCP headers.                                  | Allow static headers, require env refs, or move secret headers into MCP auth.                  | Allow static non-secret headers only; document secret boundary in MCP runtime.            | open   |
| Should system URL dependencies require `.rpm`?         | Prose says HTTPS RPM; parser checks HTTPS plus SHA-256 only.                         | Enforce suffix, remove RPM wording, or support declared package type.                          | Align parser/prose during consolidation.                                                  | open   |
| Should duplicate config keys inside a plugin fail?     | Capabilities have stronger duplicate handling; config-key sets silently collapse.    | Reject, dedupe, or warn.                                                                       | Reject for author feedback.                                                               | open   |
| Is manifest versioning required?                       | No schema version exists.                                                            | Add version now, add only before breaking changes, or rely on package versions.                | Defer until public plugin compatibility policy is defined.                                | open   |

## OpenSpec Requirements Draft

| Requirement                            | Scenarios                                                            | Source Evidence                  | Notes                        |
| -------------------------------------- | -------------------------------------------------------------------- | -------------------------------- | ---------------------------- |
| Manifest identity and parsing          | required fields, invalid name, absent arrays, unknown fields         | manifest parser/tests            | Unknown behavior open.       |
| Manifest configuration overrides       | patch, null removal, name immutable, missing override                | parser/registry tests            | Effective manifest.          |
| Capabilities and config keys           | qualification, duplicate capability                                  | parser/registry                  | Config duplicate gap.        |
| Provider domain ownership              | validate, require purpose, duplicate domains                         | parser/registry tests            | Exact domains only.          |
| Env var declarations                   | keys, placeholders, defaults, command-env secret isolation           | parser/command-env tests         | Secret boundary.             |
| API header declarations                | non-empty, env refs, no default secrets, no credential Authorization | parser tests                     | Literal header gap.          |
| Credential declarations                | oauth-bearer, github-app, domains, env vars                          | parser/tests                     | Broker consumption separate. |
| OAuth declarations                     | credentials, HTTPS endpoints, reserved params, token headers         | parser/tests, RFC 6749           | Runtime flow separate.       |
| Runtime dependencies                   | npm, system, system-url, dedupe, postinstall                         | parser/tests                     | RPM suffix gap.              |
| MCP declarations                       | http, HTTPS URL, headers, allowed tools                              | parser/tests, MCP docs           | Runtime separate.            |
| Target declarations                    | config-key membership, flags                                         | parser/spec                      | Target runtime separate.     |
| Package discovery and registry loading | package list, content, roots, duplicates, reload                     | package discovery/registry tests | Deterministic.               |
| CLI validation                         | local, packaged, ignored outside root                                | CLI tests                        | User-facing check.           |
| Verification taxonomy                  | unit, CLI, integration, eval                                         | testing spec                     | Layer ownership.             |

## Migration Notes

- Canonical spec updates:
  - Consolidate `specs/plugin-manifest.md` with this OpenSpec capability after review.
  - Keep runtime consumption details in `plugin-runtime`, `credential-injection`, `oauth-flows`, and `mcp-tool-runtime`.
- Index/pointer updates:
  - Existing `specs/index.md` and root `AGENTS.md` already list `specs/plugin-manifest.md`; add OpenSpec capability pointer after acceptance.
- Superseded content:
  - Move field-level examples into public docs or reference docs if the canonical spec becomes too detailed.
- Test/eval taxonomy changes:
  - Keep manifest syntax in unit tests and CLI validation tests.
  - Use integration tests only when consuming declarations through brokers/runtime.
  - Do not use evals to prove manifest syntax.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-plugin-manifest' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: unknown fields, literal header safety, RPM suffix alignment, duplicate config keys, manifest versioning.
