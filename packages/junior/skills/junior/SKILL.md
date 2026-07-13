---
name: junior
description: Build, review, or update Junior extension skills and plugins. Use when users ask to create a Junior SKILL.md, app skill, plugin, plugin.yaml, packaged plugin, MCP-backed plugin, OAuth or credentialed plugin, or to validate Junior extension files. Do not use for ordinary Junior usage, provider workflows, generic code editing, or non-Junior agent-skill authoring.
---

# Junior

Create or repair Junior extension files.

## References

| Need                                                                     | Read                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Choose app skill, app plugin, packaged plugin, or repo-local location    | [references/placement-and-discovery.md](references/placement-and-discovery.md)               |
| Write or review a `SKILL.md` file                                        | [references/skill-authoring.md](references/skill-authoring.md)                               |
| Write or review `plugin.yaml`                                            | [references/plugin-manifest.md](references/plugin-manifest.md)                               |
| Decide where credentials, MCP, packages, OAuth, config, and setup belong | [references/runtime-authority.md](references/runtime-authority.md)                           |
| Package a reusable plugin for npm or this monorepo                       | [references/packaging.md](references/packaging.md)                                           |
| Validate files or diagnose check failures                                | [references/validation-and-troubleshooting.md](references/validation-and-troubleshooting.md) |
| Need concrete templates, robust variants, or anti-pattern corrections    | [references/examples.md](references/examples.md)                                             |

Maintenance: [SPEC.md](SPEC.md). Provenance: [SOURCES.md](SOURCES.md).

## Workflow

1. Classify:

- App-local skill: behavior only, no provider-specific runtime authority.
- App-local plugin: provider or workflow bundle for one app.
- Packaged plugin: reusable plugin shipped as an npm package.
- Monorepo package: new or changed package under `packages/`.

2. Inspect:

- Inspect nearby `SKILL.md` files, `plugin.yaml` manifests, app docs, and package metadata.
- In this repo, treat `packages/junior-plugin-api/README.md`,
  `packages/junior/src/chat/plugins/README.md`, exported types, and validators as
  authoritative.
- Preserve: placement, manifest authority, credential secrecy, validation, discovery.

3. Choose shape:

- Skill only when no provider runtime setup is needed.
- Plugin when config, credentials, OAuth, MCP, packages, postinstall, or reuse is needed.
- References only for optional depth.

4. Author:

- Put skill behavior in `SKILL.md`.
- Put runtime authority in `plugin.yaml`.
- Put reusable package metadata in `package.json`.
- Keep secrets out of all committed files.

5. Validate:

- Run the narrowest structural check first.
- Fix every validation error before claiming the extension is complete.
- For runtime dependencies, verify snapshot creation or one real workflow when available.

## Hard rules

- Skill frontmatter owns activation only; plugin manifests own provider authority.
- Do not use `requires-capabilities` or `uses-config` in skills.
- Do not hardcode harness dispatcher mechanics in skill prose.
- Do not print, persist, or ask users to paste secrets into skill files.
- Do not create top-level `skills/` or `plugins/` in a Junior app unless local tooling explicitly requires that legacy layout.
- Do not invent manifest fields. If the parser does not support a field, omit it or change the runtime first.

## Reporting

1. Files created or changed.
2. Placement and discovery path.
3. Validation commands and result.
4. Remaining runtime verification: OAuth, MCP, credentials, snapshots, Slack.
