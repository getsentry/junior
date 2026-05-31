# Backfill `skill-runtime`

## Why

Junior supports agent skills as on-demand task guidance. Skill discovery, frontmatter validation, slash/user invocation, plugin ownership, runtime-boundary injection, allowed tool filtering, and skill-scoped file access are implemented across several modules and evals. This needs a baseline capability spec before MCP/tool/provider backfills build on it.

## What Changes

- Add an OpenSpec capability for `skill-runtime`.
- Specify skill discovery roots, SKILL.md frontmatter validation, metadata-only discovery, full body loading, invocation parsing, loadSkill results, plugin runtime boundaries, allowed tool filtering, and skill file sandboxing.
- Record prior art from Agent Skills/SKILL.md format and undefined behavior around auto-selection and disabled model invocation.
- Map current unit tests and evals.

## Impact

- Affected specs:
  - `agent-prompt`
  - `tool-execution`
  - `sandbox-tools`
  - `plugin-runtime`
  - `mcp-tool-runtime`
  - `testing`
  - `eval-testing`
- Affected code evidence:
  - `packages/junior/src/chat/skills.ts`
  - `packages/junior/src/chat/tools/skill/load-skill.ts`
  - `packages/junior/src/chat/sandbox/skill-sandbox.ts`
  - `packages/junior/src/chat/sandbox/skill-sync.ts`
  - `packages/junior/src/chat/respond.ts`
- Affected verification:
  - Unit tests for parsing/discovery/loading/file sandbox behavior.
  - Evals for skill invocation, auto-selection, explicit user-callable skills, working directory behavior, and plugin/MCP-backed skills.
