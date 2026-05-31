## Why

Junior's core prompt is a platform contract: it determines tool-use bias, source hierarchy, skill loading, Slack response shape, and dynamic context boundaries. Existing prose and tests cover much of this, but the baseline OpenSpec catalog needs a prompt capability spec that avoids freezing exact wording while still preventing prompt bloat and ownership drift.

## What Changes

- Add a baseline OpenSpec capability for `agent-prompt`.
- Convert the canonical prompt ownership and bloat-control contract into OpenSpec requirements and scenarios.
- Add a backfill worksheet documenting implementation inventory, prompt prior art, intended behavior, undefined behavior, and migration notes.
- Add a verification map that distinguishes static prompt-builder checks from model-facing eval coverage.
- Do not implement prompt, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `agent-prompt`: Platform-owned system prompt and session bootstrap context behavior, including ownership boundaries, dynamic capability disclosure, execution bias, source hierarchy, skill/tool policy, safety, output shape, and prompt-bloat controls.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/agent-prompt.md`, `specs/agent-turn-handling.md`, `specs/harness-agent.md`, `specs/slack-agent-delivery.md`, `specs/plugin-runtime.md`, `specs/trusted-plugin-heartbeat.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/prompt.ts`, `packages/junior/src/chat/respond.ts`, `packages/junior/src/chat/skills.ts`, tool definitions with `promptSnippet` / `promptGuidelines`, skill files, and prompt-related evals.
- Affected verification inventory only: prompt-builder unit tests, skill-invocation evals, source-use/reply-shape evals, integration tests that inspect prompt context wiring, and `pnpm skills:check`-style skill validation.
