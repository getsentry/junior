# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm skills:check`

## Commit Attribution
- AI commits MUST include:
```
Co-Authored-By: (agent model name) <email>
```

## Key Conventions
- Load `slack-development` skill before implementing or modifying Slack-facing behavior (message formatting, ephemeral messages, thread routing, streaming UX, Chat SDK patterns).
- Commit to `main` only.
- Use `/commit` skill for any commit operation.
- Use `/create-pr` skill for any PR creation operation.
- Use `/skill-creator` skill when creating or updating skills.
- Use evals for end-to-end behavior testing (excluding live Slack transport/integration). See `evals/README.md`.
- Use instrumentation conventions from `specs/logging/index.md`.
- Use OpenTelemetry semantic keys for logs; when no semantic key exists, use `app.*`.
- Minimize defensive programming — no fallbacks when systems are expected to work. Ensure errors are captured correctly. Use retries for expected network failures, nothing more.
- Prefer minimal interfaces and simple components across the codebase.
- Keep public surfaces small: fewer exported types/functions, fewer integration points, explicit contracts.
- Prefer composition over abstractions that add indirection without clear reuse.
- Prefer standards/library-native patterns before custom infrastructure.
- Prefer standards-based streaming surfaces over custom transport loops.
- Chat SDK streaming standard: pass `AsyncIterable<string>` to `thread.post(...)`.
- Pi SDK streaming standard: consume `Agent` events (`message_update`/`text_delta`) and bridge deltas into the `AsyncIterable` shim.
- Avoid bespoke Slack `chat.update` loops unless required by a hard platform limitation.
- Prefer hard cutover for command/skill renames and behavior migrations unless the user explicitly requests backward compatibility.

## Known Specs
- `specs/security-policy.md` (global runtime/container/token security policy)
- `specs/skill-capabilities-spec.md` (capability declaration + broker/injection contract)
- `specs/oauth-flows.md` (OAuth authorization code flow + Slack UX contract)
- `specs/harness-agent-spec.md` (agent loop and output contract)
- `specs/logging/index.md` (logging/tracing spec index)
- `specs/agent-stability-evaluation.md` (known stability risks and mitigations)
- `specs/plugin-spec.md` (plugin architecture for self-contained provider integrations)
- `specs/testing/index.md` (testing taxonomy and layer boundaries: unit/integration/eval)
