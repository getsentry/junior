# Runtime Authority Boundary

Skills describe behavior. Plugins declare authority.

## Put this in `plugin.yaml`

| Runtime need                             | Manifest owner                                   |
| ---------------------------------------- | ------------------------------------------------ |
| Provider permissions                     | `capabilities`                                   |
| Conversation or install defaults         | `config-keys` plus optional app `configDefaults` |
| OAuth bearer delivery                    | `credentials` and `oauth`                        |
| GitHub App delivery                      | `credentials`                                    |
| Static or deployment-backed HTTP headers | `env-vars`, `domains`, `api-headers`             |
| CLI or npm package availability          | `runtime-dependencies`                           |
| System packages in the sandbox           | `runtime-dependencies`                           |
| Postinstall/bootstrap command            | `runtime-postinstall`                            |
| Hosted MCP endpoint                      | `mcp.url`                                        |
| MCP tool allowlist                       | `mcp.allowed-tools`                              |
| Provider target flag defaults            | `target`                                         |

## Put this in `SKILL.md`

- Operation selection and workflow.
- How to use provider commands or active provider tools once available.
- How to resolve targets from explicit user input and configured defaults.
- How to summarize results.
- How to report access, setup, auth, or permission failures.
- When to ask a concise follow-up.

## Secrets

- Secrets never belong in skill files or committed manifests.
- Manifest env var names may be committed; secret values stay in deployment configuration.
- Runtime credential leases are actor-bound; sandbox command leases are command-scoped.
- Missing or stale OAuth is handled by Junior's private authorization flow.

## Dependencies

- Sandbox OS is Amazon Linux 2023.
- Runtime packages and postinstall steps are manifest-owned.
- If a declared CLI is unavailable, report `<plugin> plugin runtime setup failure`.

## MCP

- Declare hosted HTTP MCP servers in `plugin.yaml`.
- Use `allowed-tools` for least surface.
- Skills describe provider tasks in domain terms.
- If MCP auth is required, Junior handles the pause and resume flow.

## Placement test

1. Would this instruction grant access, install software, or configure auth?
   Put it in `plugin.yaml` or host deployment docs.
2. Would this instruction help choose or execute a user workflow after the runtime surface exists?
   Put it in `SKILL.md`.
3. Would a malicious skill author gain more authority by changing this prose?
   Move it to the manifest or runtime.
