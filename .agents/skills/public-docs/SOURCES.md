# Sources

## Local source inventory

- `AGENTS.md` (repo-level agent conventions and skill usage requirements)
- `packages/docs/src/content/docs/contribute/documentation-guidelines.md` (page types, depth targets, cross-page standards)
- `packages/docs/astro.config.mjs` (sidebar, redirects, Typedoc integration, docs app structure)
- `packages/docs/src/content/docs/contribute/development.md` (docs/dev checks and commands)
- `packages/docs/src/content/docs/contribute/testing.md` (test command patterns)
- `packages/docs/src/content/docs/contribute/releasing.md` (docs preflight expectations)
- `/home/dcramer/.codex/skills/.system/skill-creator/SKILL.md` (skill scaffolding and validation workflow)

## Key authoring decisions

1. Use a workflow-first `SKILL.md` with strict invariants to keep docs quality consistent.
2. Add three focused references (`api-surface`, `common-use-cases`, `troubleshooting-workarounds`) for progressive disclosure.
3. Center guidance on `packages/docs` local contracts rather than generic doc-writing advice.
4. Keep commands minimal (`pnpm docs:check`, `pnpm docs:build`) and tied to change scope.
