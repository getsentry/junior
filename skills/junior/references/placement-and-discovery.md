# Placement And Discovery

Choose placement before writing files.

## Decision table

| Request                                      | Put files here                                                                                          | Use when                                                                                                | Validate with                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| App-specific behavior with no provider setup | `app/skills/<skill-name>/SKILL.md`                                                                      | The skill only changes how Junior reasons or responds.                                                  | `pnpm exec junior check` from the app root                       |
| App-specific provider or tool bundle         | `app/plugins/<plugin-name>/plugin.yaml` plus `app/plugins/<plugin-name>/skills/<skill-name>/SKILL.md`   | The workflow needs config keys, credentials, OAuth, MCP, runtime packages, API headers, or postinstall. | `pnpm exec junior check` from the app root                       |
| Reusable provider or workflow package        | package root `plugin.yaml` plus `skills/<skill-name>/SKILL.md`                                          | Multiple apps should install the same plugin.                                                           | package-local checks plus a configured host-app runtime load     |
| This monorepo's packaged provider            | `packages/junior-<provider>/plugin.yaml` plus `packages/junior-<provider>/skills/<skill-name>/SKILL.md` | The provider ships as an `@sentry/junior-*` package.                                                    | `pnpm skills:check` and release checks when package lists change |
| Built-in Junior runtime skill                | `packages/junior/skills/<skill-name>/SKILL.md`                                                          | Every Junior app should make the skill available to its agent and sandbox.                              | `pnpm skills:check` and targeted runtime discovery tests         |
| Repository-development skill                 | `skills/<skill-name>/SKILL.md`                                                                          | The skill guides coding agents working on this repository and is not shipped to Junior apps.            | `pnpm skills:check`                                              |

## Discovery rules

- Junior app validation checks `app/skills` and `app/plugins`.
- `junior check` ignores legacy top-level `skills/` and `plugins/` in app roots.
- Runtime app skills come from the resolved app home directory's `skills/` folder.
- Built-in runtime skills come from `packages/junior/skills` and ship in the `@sentry/junior` package.
- App-local plugin skills come from `app/plugins/<plugin-name>/skills`.
- Packaged plugin content is discovered only from explicitly configured plugin package names.
- A package may expose a root `plugin.yaml`, a `plugins/` directory, a `skills/` directory, or a combination supported by package discovery.
- `junior check` validates app-local plugin manifests; packaged plugin manifests must be exercised through a configured app/runtime or a targeted parser test.

## Placement guardrails

- Use `app/skills` only when the skill does not need manifest-owned authority.
- Use a plugin as soon as the workflow needs provider-specific runtime setup.
- Do not copy a packaged plugin into an app unless the user wants an app-local fork.
- Keep repository-development skills under the repository root `skills/`; do not put app or built-in runtime skills there.
- Keep skill names globally unique across built-in, app-local, and plugin skill roots in the same app.
