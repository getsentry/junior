# Backfill `advisor-tool`

## Why

Junior's `advisor` tool is a nested, stronger Pi agent used by the main executor for hard technical reasoning. Its contract sits between ordinary tool execution and multi-agent delegation: the advisor can inspect with read-only tools and maintain private conversation-scoped history, but it must not own implementation, mutate state, post to Slack, or silently inherit the parent transcript. The current prose spec, implementation, tests, and prior-art notes need to be converted into baseline OpenSpec requirements before canonical consolidation.

## What Changes

- Add an OpenSpec capability for `advisor-tool`.
- Specify advisor availability, configuration, input validation, explicit context packet construction, nested Pi invocation, read-only tool filtering, session persistence, failure handling, and observability.
- Record prior art from Claude Code subagents, Claude Agent SDK subagents, and Amp Oracle.
- Record open questions around history retention, compaction, failure shape, and advisor recursion.

## Impact

- Affected specs:
  - `tool-execution`
  - `agent-execution`
  - `harness-agent`
  - `context-compaction`
  - `agent-session-resumability`
  - `agent-prompt`
  - `instrumentation`
  - `testing`
  - `eval-testing`
- Affected code evidence:
  - `specs/advisor-tool.md`
  - `packages/junior/src/chat/tools/advisor/tool.ts`
  - `packages/junior/src/chat/tools/advisor/session-store.ts`
  - `packages/junior/src/chat/respond.ts`
  - `packages/junior/src/chat/tools/index.ts`
  - `packages/junior/src/chat/config.ts`
- Affected verification:
  - Config unit tests for advisor defaults/overrides/invalid settings.
  - Advisor integration tests for exposure, explicit context, read-only tool subset, session continuity, and validation failures.
  - Future evals for model-facing advisor-use policy and useful advisor incorporation on hard tasks.
