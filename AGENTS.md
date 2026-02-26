# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm skills:check`

## Commit Attribution
- AI commits MUST include:
```
Co-Authored-By: (agent model name) <email>
```

## Key Conventions
- Commit to `main` only.
- Use `/commit` skill for any commit operation.
- Use `/create-pr` skill for any PR creation operation.
- Use `/skill-creator` skill when creating or updating skills.
- Use instrumentation conventions from `docs/logging/index.md`.
- Use OpenTelemetry semantic keys for logs; when no semantic key exists, use `app.*`.

## Local Skills
- Use `agents-md` for `AGENTS.md`/`CLAUDE.md` maintenance. See `.agents/skills/agents-md/SKILL.md`
- Use `brand-guidelines` for user-facing copy. See `.agents/skills/brand-guidelines/SKILL.md`
- Use `commit` for commits. See `.agents/skills/commit/SKILL.md`
- Use `create-pr` for pull requests. See `.agents/skills/create-pr/SKILL.md`
- Use `dotagents` for `agents.toml`/`agents.lock` and skill dependency management. See `.agents/skills/dotagents/SKILL.md`
- Use `iterate-pr` for fixing CI/review feedback in a PR loop. See `.agents/skills/iterate-pr/SKILL.md`
- Use `skill-creator` for creating or updating skills. See `.agents/skills/skill-creator/SKILL.md`
