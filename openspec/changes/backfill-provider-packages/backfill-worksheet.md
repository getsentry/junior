# Provider Packages Backfill Worksheet

## Canonical Spec

- New spec: `provider-packages`

## Local Artifacts Reviewed

- `packages/junior-github/plugin.yaml`
- `packages/junior-sentry/plugin.yaml`
- `packages/junior-linear/plugin.yaml`
- `packages/junior-notion/plugin.yaml`
- `packages/junior-datadog/plugin.yaml`
- `packages/junior-hex/plugin.yaml`
- `packages/junior-agent-browser/plugin.yaml`
- `packages/junior-{github,sentry,linear,notion,datadog,hex,agent-browser}/package.json`
- `packages/junior-{github,sentry,linear,notion,datadog,hex,agent-browser}/README.md`
- `packages/junior-{github,sentry,linear,notion,datadog,hex,agent-browser}/skills/*/SKILL.md`
- `packages/junior-github/index.js`
- `packages/docs/src/content/docs/extend/*-plugin.md`
- `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
- `packages/junior/tests/unit/config/package-discovery.test.ts`
- `packages/junior/tests/unit/cli/check-cli.test.ts`
- `packages/junior/tests/unit/cli/snapshot-warmup-cli.test.ts`
- `packages/junior/tests/unit/plugins/github-app-broker.test.ts`
- `packages/junior/tests/unit/plugins/agent-hooks.test.ts`
- `packages/junior/tests/integration/example-build-discovery.test.ts`
- `packages/junior-evals/evals/github/skill-workflows.eval.ts`
- `packages/junior-evals/evals/sentry/skill-workflows.eval.ts`

## External Sources

- GitHub App installation access token docs: https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- Sentry API auth docs: https://docs.sentry.io/api/auth/
- Sentry API permissions docs: https://docs.sentry.io/api/permissions/
- Linear MCP docs: https://linear.app/docs/mcp/
- Notion MCP docs: https://developers.notion.com/guides/mcp/mcp
- Datadog API and application keys docs: https://docs.datadoghq.com/account_management/api-app-keys/
- Datadog API docs: https://docs.datadoghq.com/api/
- Datadog Pup CLI docs: https://docs.datadoghq.com/cli/
- Hex MCP docs: https://learn.hex.tech/docs/api-integrations/mcp-server
- agent-browser installation docs: https://agent-browser.dev/installation

## Existing Behavior Summary

- First-party provider packages are public npm packages named `@sentry/junior-<provider>`.
- Provider packages publish `plugin.yaml` and bundled `skills`; GitHub additionally publishes trusted hook entrypoints.
- Provider manifests declare runtime setup, not skill frontmatter.
- Hosted MCP packages point at provider-owned remote MCP URLs and may declare allowlisted tools.
- GitHub and Sentry have evals for provider workflow behavior; other packages mainly have package/runtime coverage.
- GitHub's trusted plugin registers its own package and enforces commit attribution through sandbox hooks.

## Spec Decisions

- Keep `provider-packages` focused on package/artifact/runtime contracts.
- Do not merge detailed workflow behavior for all providers into this baseline.
- Treat provider workflow specs as follow-up when the workflow is write-capable, eval-covered, target-sensitive, long-running, or auth/resume-sensitive.
- Treat public docs and `plugin.yaml` as parallel public contracts that must not drift.
- Treat hosted MCP provider tool inventory as external and unstable unless an allowlist is declared.

## Undefined Behavior

| Question                                                                        | Current Evidence                                                                  | Candidate Decision                                                                                       | Status |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| What compatibility guarantee exists between core and provider package versions? | CLI warns on official package version mismatch.                                   | Require matching minor/patch or publish explicit compatibility table.                                    | open   |
| Must README files be included in published package tarballs?                    | Package `files` mostly omit README but npm includes README by default if present. | Make README presence required in source; decide tarball inclusion in release spec.                       | open   |
| Should every hosted MCP provider use an allowlist?                              | Notion and Hex allowlist; Linear does not.                                        | Require allowlists for write-capable hosted MCP providers or document why provider discovery is trusted. | open   |
| How are docs kept synchronized with manifests?                                  | Docs manually list env vars/scopes/setup.                                         | Add docs-manifest drift check in docs-site or release packaging.                                         | open   |
| Which providers need dedicated workflow specs?                                  | GitHub/Sentry evals exist; Linear/agent-browser have significant user workflows.  | Backfill GitHub, Sentry, Linear, agent-browser first; defer Datadog/Notion/Hex until behavior grows.     | open   |

## Validation

- `openspec validate backfill-provider-packages --strict` passed.
