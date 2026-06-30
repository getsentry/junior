# Validation And Troubleshooting

## Validation commands

| Context                                     | Command                                        | Passing state                                                           |
| ------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Consumer app                                | `pnpm exec junior check`                       | Prints `Validation passed` or only expected warnings.                   |
| Consumer app from another directory         | `pnpm exec junior check path/to/app`           | Same as above.                                                          |
| This repo core skill files                  | `pnpm skills:check`                            | Reports skill validation passed.                                        |
| Packaged plugin manifest                    | configured app startup or targeted parser test | The package `plugin.yaml` is parsed without errors.                     |
| Runtime code changed                        | `pnpm typecheck` and targeted tests            | Typecheck and tests pass.                                               |
| Docs changed                                | `pnpm docs:check`                              | Docs checker passes.                                                    |
| Release package lists changed               | `pnpm release:check`                           | Release config is aligned.                                              |
| Runtime dependencies or postinstall changed | `junior snapshot create`                       | Snapshot inputs match expected plugin dependencies and warmup succeeds. |

## App validation scope

`junior check` validates:

- `app/plugins/<plugin>/plugin.yaml`
- `app/plugins/<plugin>/skills/<skill>/SKILL.md`
- `app/skills/<skill>/SKILL.md`
- app marker files when the target looks like a Junior app

It does not validate:

- legacy top-level app `skills/` or `plugins/`
- installed package root `plugin.yaml`

For packaged plugins, load a configured host app or add a parser test.

## Common failures

| Symptom                                                                                   | Likely cause                                                                                                   | Fix                                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `name must match directory`                                                               | Frontmatter `name` differs from folder name.                                                                   | Rename the folder or the skill `name`.                                                                    |
| `duplicate skill name`                                                                    | App and plugin skill roots contain the same skill name.                                                        | Rename one skill and adjust trigger language.                                                             |
| `requires-capabilities is no longer supported`                                            | Old skill-level auth metadata.                                                                                 | Move capabilities to `plugin.yaml`.                                                                       |
| `uses-config is no longer supported`                                                      | Old skill-level config metadata.                                                                               | Move config keys to `plugin.yaml`.                                                                        |
| `skill instructions must not hardcode harness tool-discovery or MCP dispatcher mechanics` | Skill prose names internal dispatcher APIs or active catalog tags.                                             | Describe provider actions in domain terms instead.                                                        |
| `api-headers requires domains`                                                            | Manifest declares headers without target domains.                                                              | Add valid `domains` or remove `api-headers`.                                                              |
| `domains requires credentials or api-headers`                                             | `plugin.yaml` declares top-level domains without a generic credential/header path.                             | Add `api-headers` or bearer credentials, or move egress ownership into a code plugin with hooks.          |
| `oauth requires credentials`                                                              | `plugin.yaml` OAuth block has no credential delivery config.                                                   | Add `credentials.type: oauth-bearer`, or move OAuth plus egress ownership into a code plugin with hooks.  |
| `unsupported credentials.type: "plugin-managed"`                                          | `plugin.yaml` tried to declare hook-owned credentials.                                                         | Remove the credential block and register `grantForEgress` plus `issueCredential` hooks from code.         |
| `mcp.url references env var ... not declared`                                             | Placeholder is not listed in `env-vars`.                                                                       | Declare the env var and optional default where allowed.                                                   |
| `API header env vars must not declare defaults`                                           | Secret-like header env var has a default.                                                                      | Remove the default and set the value in deployment env.                                                   |
| `target.config-key ... must be listed in config-keys`                                     | Target points at undeclared config.                                                                            | Add the short config key to `config-keys`.                                                                |
| Plugin does not load in app                                                               | Package installed but it is missing from `defineJuniorPlugins(...)`, or local files are outside `app/plugins`. | Add the package name or plugin factory to the runtime-safe plugin set, or move files under `app/plugins`. |
| Skill does not show up                                                                    | Skill is in a legacy root, has invalid frontmatter, or duplicates another skill name.                          | Move under `app/skills` or plugin `skills`, then rerun validation.                                        |

## Runtime verification

1. Ask Junior for one realistic workflow that should trigger the new skill.
2. For credentialed plugins, verify the auth prompt is private and the resumed turn succeeds.
3. For MCP plugins, verify the relevant provider tools are available only after the plugin skill is loaded.
4. For runtime dependencies, confirm snapshot warmup includes the expected package and postinstall counts.
5. For Slack deployments, verify both a direct message and a channel path when the workflow is Slack-facing.

## Failure handling

- If a validator fails, read the exact first error and fix the root cause before retrying.
- If a runtime workflow fails after validation, separate manifest setup failures from skill behavior failures.
- If a provider returns permission or scope errors, report the concrete provider message. Do not guess missing scopes.
- If credentials are missing or stale, let Junior handle reconnect.
