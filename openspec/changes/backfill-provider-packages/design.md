# Design: Provider Package Baseline

## Research Summary

Local sources reviewed:

- Provider manifests:
  - `packages/junior-github/plugin.yaml`
  - `packages/junior-sentry/plugin.yaml`
  - `packages/junior-linear/plugin.yaml`
  - `packages/junior-notion/plugin.yaml`
  - `packages/junior-datadog/plugin.yaml`
  - `packages/junior-hex/plugin.yaml`
  - `packages/junior-agent-browser/plugin.yaml`
- Provider packages:
  - package metadata under `packages/junior-{github,sentry,linear,notion,datadog,hex,agent-browser}/package.json`
  - provider READMEs and setup guides
  - bundled `skills/*/SKILL.md` files and references
  - `packages/junior-github/index.js` and `index.d.ts`
- Public docs:
  - `packages/docs/src/content/docs/extend/github-plugin.md`
  - `packages/docs/src/content/docs/extend/sentry-plugin.md`
  - `packages/docs/src/content/docs/extend/linear-plugin.md`
  - `packages/docs/src/content/docs/extend/notion-plugin.md`
  - `packages/docs/src/content/docs/extend/datadog-plugin.md`
  - `packages/docs/src/content/docs/extend/hex-plugin.md`
  - `packages/docs/src/content/docs/extend/agent-browser-plugin.md`
- Runtime/test coverage:
  - `packages/junior/src/chat/plugins/package-discovery.ts`
  - `packages/junior/src/chat/plugins/manifest.ts`
  - `packages/junior/src/chat/plugins/registry.ts`
  - `packages/junior/src/chat/skills.ts`
  - `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
  - `packages/junior/tests/unit/config/package-discovery.test.ts`
  - `packages/junior/tests/unit/cli/check-cli.test.ts`
  - `packages/junior/tests/unit/cli/snapshot-warmup-cli.test.ts`
  - `packages/junior/tests/unit/plugins/github-app-broker.test.ts`
  - `packages/junior/tests/unit/plugins/agent-hooks.test.ts`
  - `packages/junior/tests/integration/example-build-discovery.test.ts`
  - `packages/junior-evals/evals/github/skill-workflows.eval.ts`
  - `packages/junior-evals/evals/sentry/skill-workflows.eval.ts`

External primary sources reviewed:

- GitHub App installation access token docs: installation tokens are generated for an installation, can be narrowed by repository and permission, and otherwise inherit app installation permissions.
- Sentry API authentication and permissions docs: OAuth/token scopes gate API endpoints, with `event:read`, `org:read`, `project:read`, and `team:read` matching the packaged Sentry read-only investigation surface.
- Linear MCP docs: Linear provides a centrally hosted authenticated remote MCP server with Streamable HTTP transport and OAuth-based auth.
- Notion MCP docs: Notion provides a hosted MCP server and distinguishes hosted remote MCP from local self-hosted API-token setup.
- Datadog API key and application key docs: Datadog API access commonly uses API keys plus application keys, and application keys can be scope-limited.
- Datadog Pup CLI docs: Pup is an AI-agent-ready CLI, supports agent mode, and exposes read-only operation controls.
- Hex MCP docs: Hex exposes `https://app.hex.tech/mcp` for MCP access to search projects and create/continue Threads.
- agent-browser installation docs: agent-browser is installed as an npm package/CLI and has an explicit install/provisioning step.

## Prior Art

Provider marketplaces generally separate package shape from provider workflow semantics:

- Package managers define artifact inclusion, package naming, versioning, and dependency metadata.
- OAuth and app integrations define auth and permission scope outside prompt text.
- Hosted MCP providers centralize tool discovery and user authorization at the provider endpoint.
- CLI-backed agent integrations usually make binary installation and postinstall/provisioning an explicit runtime setup concern rather than burying it inside prompt instructions.

Junior should follow the same split:

- The shared `provider-packages` spec owns what a first-party package must declare and ship.
- Provider-specific specs own the exact user workflows, target-selection rules, approval rules, and eval rubrics for GitHub issues/PRs, Sentry investigations, Linear issue creation, browser automation, and similar domain behavior.

## Current Inventory

| Package                        | Shape                    | Manifest-owned setup                                                     | Notable package behavior                                                                    |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `@sentry/junior-github`        | GitHub App + CLI/API     | GitHub App credentials, `gh` dependency, repo target config, command env | Exports `githubPlugin()` trusted hooks for git attribution and plugin package registration. |
| `@sentry/junior-sentry`        | per-user OAuth + CLI/API | Sentry OAuth metadata, Sentry CLI npm dependency, read-only scopes       | Bundled skill uses live `sentry` CLI/API surfaces.                                          |
| `@sentry/junior-linear`        | hosted MCP               | remote MCP URL and config keys                                           | User auth happens through Linear MCP; no shared API key required.                           |
| `@sentry/junior-notion`        | hosted MCP               | remote MCP URL and allowlisted tools                                     | Package limits exposed Notion tools to search/fetch.                                        |
| `@sentry/junior-datadog`       | API keys + CLI           | Datadog env vars, API headers, domains, Pup postinstall                  | Read-only Pup CLI mode is injected through command env.                                     |
| `@sentry/junior-hex`           | hosted MCP               | remote MCP URL and allowlisted thread tools                              | Supports Hex Threads through MCP.                                                           |
| `@sentry/junior-agent-browser` | CLI/browser runtime      | npm and system runtime dependencies, `agent-browser install` postinstall | Heavy sandbox snapshot dependency package.                                                  |

## Scope Decision

This baseline should remain shared and package-focused. It should not try to specify every provider workflow because that would duplicate skill instructions, evals, public docs, and provider APIs in one oversized spec.

Provider-specific workflow specs should be created when one of these is true:

- The package has evals or expected model behavior beyond loading a skill.
- The integration writes to external systems.
- Target selection can be ambiguous, such as GitHub repo selection or Linear team/project selection.
- The integration performs long-running, interactive, or browser automation work.
- The integration has user-visible authorization/resume behavior beyond the generic plugin/MCP auth contract.

That implies follow-up workflow specs are most valuable for GitHub, Sentry, Linear, and agent-browser first. Datadog, Notion, and Hex can start with package-level coverage unless evals or production usage require tighter workflow contracts.

## Undefined Behavior

- Provider package compatibility with core `@sentry/junior` is checked for version mismatch, but the public compatibility promise is not yet defined.
- The package artifact contract does not yet say whether every public provider package must include a README in the published tarball; current packages publish `plugin.yaml` and `skills`, while GitHub also publishes `SETUP.md` and runtime hook exports.
- Public docs and manifests can drift because no single check compares docs tables against manifest `env-vars`, `config-keys`, `oauth`, `mcp`, or `runtime-dependencies`.
- Hosted MCP package behavior relies on provider tool lists that can change server-side. Allowlisted tools limit Notion/Hex, but Linear currently relies on remote discovery without a package allowlist.
- Per-provider skill source provenance is uneven. Sentry has `SOURCES.md`; other packages mostly rely on embedded references.
- Agent-browser postinstall depends on browser/system packages and external provisioning behavior; the package baseline should treat this as runtime setup, while security and sandbox resource limits need separate coverage.

## Verification Strategy

- Unit tests cover manifest parsing, plugin package discovery, runtime dependency parsing, package version warnings, skill metadata validation, trusted hook registration, and GitHub App auth broker behavior.
- Integration tests cover built example discovery and deployed route/package recognition.
- Evals currently cover GitHub and Sentry skill workflows; these should remain behavior-oriented and not become packaging tests.
- Missing coverage should be tracked in provider-specific workflow backfills rather than inflating this package baseline.
