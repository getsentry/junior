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
- Use evals for end-to-end behavior testing (excluding live Slack transport/integration). See `evals/README.md`.
- Use instrumentation conventions from `specs/logging/index.md`.
- Use OpenTelemetry semantic keys for logs; when no semantic key exists, use `app.*`.

## Known Specs
- `specs/security-policy.md` (global runtime/container/token security policy)
- `specs/skill-capabilities-spec.md` (capability declaration + broker/injection contract)
- `specs/harness-agent-spec.md` (agent loop and output contract)
- `specs/logging/index.md` (logging/tracing spec index)
- `specs/agent-stability-evaluation.md` (known stability risks and mitigations)

## Local Skills
- Use `agents-md` for `AGENTS.md`/`CLAUDE.md` maintenance. See `.agents/skills/agents-md/SKILL.md`
- Use `brand-guidelines` for user-facing copy. See `.agents/skills/brand-guidelines/SKILL.md`
- Use `commit` for commits. See `.agents/skills/commit/SKILL.md`
- Use `create-pr` for pull requests. See `.agents/skills/create-pr/SKILL.md`
- Use `dotagents` for `agents.toml`/`agents.lock` and skill dependency management. See `.agents/skills/dotagents/SKILL.md`
- Use `iterate-pr` for fixing CI/review feedback in a PR loop. See `.agents/skills/iterate-pr/SKILL.md`
- Use `skill-creator` for creating or updating skills. See `.agents/skills/skill-creator/SKILL.md`
