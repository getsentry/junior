# Junior Extension Skill Specification

## Intent

Create, review, and repair Junior skills/plugins while preserving the `SKILL.md` vs `plugin.yaml` authority split.

## Scope

In:

- `app/skills/<skill>/SKILL.md`
- `app/plugins/<plugin>/plugin.yaml`
- `app/plugins/<plugin>/skills/<skill>/SKILL.md`
- packaged plugin roots with `plugin.yaml` and `skills/`
- `packages/junior-*` plugin packages
- validation and common check failures

Out:

- ordinary provider workflows
- non-Junior skill authoring
- core runtime contract changes without owning docs/tests
- secrets

## Trigger

Use for: create Junior skill/plugin, add `plugin.yaml`, package plugin, fix `junior check`, move auth/setup out of skill prose, add MCP/OAuth.

Do not use for: existing provider usage, generic code review, docs-only edits.

## Contract

- First: classify placement, inspect nearby conventions, identify manifest-owned authority.
- Output: files/guidance, discovery path, validation result, remaining runtime checks.
- Constraints: credentials/setup in `plugin.yaml`; no deprecated skill frontmatter; fix validation errors.

## Sources

Authoritative:

- `packages/junior-plugin-api/README.md`
- `packages/junior/src/chat/plugins/README.md`
- `packages/junior/src/chat/credentials/README.md`
- `packages/docs/src/content/docs/extend/index.md`
- `packages/docs/src/content/docs/cli/check.md`
- `packages/junior/src/chat/skills.ts`
- `packages/junior/src/chat/plugins/manifest.ts`
- `packages/junior/src/cli/check.ts`
- `packages/junior/scripts/check-skills.mjs`

## Files

| File          | Purpose                           |
| ------------- | --------------------------------- |
| `SKILL.md`    | trigger, routing, workflow, rules |
| `references/` | focused runtime guidance          |
| `SOURCES.md`  | provenance, decisions, gaps       |
| `SPEC.md`     | maintenance contract              |

## Validation

- Skill: skill-writer validator and `pnpm skills:check`.
- App: `pnpm exec junior check`.
- Runtime: one real workflow for OAuth, credentials, MCP, dependencies, or postinstall.
- Tests: only when parser/discovery/runtime behavior changes.

## Maintenance

- Update `SKILL.md`: triggers, workflow, hard rules.
- Update `plugin-manifest.md`: manifest parser changes.
- Update `validation-and-troubleshooting.md`: validator changes.
- Update `SOURCES.md`: source, decision, or gap changes.
