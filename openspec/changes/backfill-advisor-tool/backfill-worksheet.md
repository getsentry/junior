# Backfill Worksheet: `advisor-tool`

## Scope

- Capability: Advisor tool
- Change: `backfill-advisor-tool`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/advisor-tool.md` plus `openspec/specs/advisor-tool/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/advisor-tool.md`: existing normative prose contract for advisor tool behavior.
- `specs/tool-execution.md`: shared tool wrapping and expected failure policy.
- `specs/agent-execution.md`: executor discipline, hard-task review, and completion gates.
- `specs/harness-agent.md`: Pi agent turn runtime contract.
- `specs/context-compaction.md`: private history and compaction boundaries.
- `specs/agent-session-resumability.md`: nested/resumed context concerns.
- `specs/agent-prompt.md`: prompt ownership and model-facing tool use.
- `specs/instrumentation.md`, `specs/tracing.md`, `specs/otel-semantics.md`: span ownership and semantic attributes.
- `specs/testing.md` and `specs/eval-testing.md`: test/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/tools/advisor/tool.ts`: advisor tool definition, description, system prompt, input validation, context packet construction, read-only tool filtering, nested Pi invocation, failure results, and tracing.
- `packages/junior/src/chat/tools/advisor/session-store.ts`: advisor session key, state adapter load/save, clone behavior, and TTL.
- `packages/junior/src/chat/respond.ts`: main runtime creation of advisor runtime context and advisor tool definitions.
- `packages/junior/src/chat/tools/index.ts`: conditional exposure of `advisor`.
- `packages/junior/src/chat/config.ts`: advisor model/thinking configuration defaults and validation.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/config/chat-config.test.ts`
  - `packages/junior/tests/unit/runtime/respond-lazy-sandbox.test.ts` partial advisor config fixture coverage.
- Integration:
  - `packages/junior/tests/integration/advisor/advisor-tool.test.ts`
- Evals:
  - No clearly scoped advisor eval found in current inventory.

## Prior Art

- Claude Code subagents isolate context, use custom prompts, can restrict tools, and are useful for exploration that would otherwise bloat the main conversation.
- Claude Agent SDK subagents make parent-to-subagent transfer explicit: subagents do not receive the parent transcript or tool results unless included in the prompt; the parent receives the final subagent message as a tool result.
- Claude subagents can be resumed, but resume requires explicit session/agent identity; Junior instead persists one advisor history per parent conversation.
- Amp Oracle exposes a stronger read-only model as a tool for review, debugging, analysis, and deciding what to do next, while relying on explicit prompting to avoid routine cost/latency overhead.

Sources:

- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Amp Oracle: https://ampcode.com/news/oracle

## Implemented Behavior

- Behavior that code currently enforces:
  - `advisor` is exposed only when `context.advisor` exists.
  - Advisor config defaults to `openai/gpt-5.5` and thinking level `xhigh`; invalid model IDs or thinking levels fail at config load.
  - `question` and `context` must be non-empty strings after trimming.
  - Advisor request text is XML-escaped and wrapped in `<advisor-task>` and `<executor-context>`.
  - Missing `conversationId` returns `missing_conversation_id` and avoids orphan session creation.
  - Advisor session key is `junior:<conversationId>:advisor_session`.
  - Advisor messages are loaded before the nested run and saved after successful assistant output.
  - Advisor tools are filtered to `readOnlyHint: true` and not `destructiveHint: true`; `searchMcpTools` and `callMcpTool` are explicitly excluded.
  - Advisor runs as a Pi `Agent` with advisor model, thinking level, system prompt, session ID, and host-provided stream function.
  - Advisor success returns assistant text exactly as tool result text with `ok:true`.
  - Advisor validation/session/inference/output/save failures return `ok:false` with stable error codes.
  - Advisor invocation creates an `ai.invoke_advisor` span and sets standard model/usage attributes when available.
- Behavior that tests currently verify:
  - Advisor tool exposure gate.
  - Executor-curated context and advisor tools reach the nested agent.
  - Read-only metadata filtering and the current real read-only tool set.
  - Advisor session continuity across calls in one parent conversation.
  - Invalid context avoids inference.
  - Advisor config defaults, overrides, and invalid settings.
- Behavior that appears accidental or weakly enforced:
  - No explicit test for invalid/blank question.
  - No explicit tests for load/save failures, missing conversation id, no assistant, or aborted/error stop reasons.
  - No explicit test that `advisor` itself is excluded from advisor tool definitions; current construction likely excludes it because it is not read-only.
  - Existing failure shape uses `ok:false`, which may conflict with the broader tool-execution preference for thrown expected tool errors.
  - No eval verifies the main model consults advisor only for hard tasks or uses the guidance correctly.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Advisor is a stronger, read-only, nested technical consultant for hard work.
  - Main executor owns implementation, verification, and user-visible output.
  - Parent transcript is not implicitly forked; context transfer is explicit.
  - Advisor history is private, conversation-scoped, and not copied into the main Pi transcript beyond the bounded tool result.
  - Advisor failures are non-fatal.
- Behavior that should remain implementation detail:
  - Exact advisor system prompt prose.
  - Exact default model ID after model catalog changes.
  - Exact memo section headings.
  - Exact OpenTelemetry helper functions.
- Behavior that should be non-goal:
  - Multi-agent teams or parallel advisor fan-out.
  - Advisor file edits, Slack posts, user questions, or recursive nested agents.
  - MCP bridge access until nested auth/resume is specified.

## Undefined Behavior / Open Questions

| Question                                            | Evidence                                                                                    | Options                                                                         | Recommendation                                                 | Status |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| Should advisor failures throw expected tool errors? | Current implementation returns `ok:false`; tool-execution prefers repairable thrown errors. | Keep non-fatal result, throw expected errors, or split validation vs runtime.   | Keep non-fatal until tool-family error audit.                  | open   |
| How is long advisor history bounded?                | Advisor state persists full Pi messages with parent TTL; compaction not specified.          | Add advisor compaction, share context compaction, or cap messages.              | Specify after context-compaction consolidation.                | open   |
| Should advisor have max turns/timeouts?             | Nested Pi run uses parent runtime context but no advisor-specific limit in spec.            | Parent timeout only, advisor-specific max turns, or config.                     | Add explicit guard if long runs are observed.                  | open   |
| Should advisor access MCP tools?                    | Existing spec excludes MCP without nested auth/resume contract.                             | Keep excluded, allow read-only MCP providers, or add nested auth.               | Keep excluded until MCP auth/resume is specified.              | open   |
| Should evals require advisor use?                   | No advisor evals found; advisor description is model-facing policy.                         | Require use on hard tasks, only verify outcomes, or classify opportunistically. | Add eval taxonomy entry before adding broad advisor-use evals. | open   |

## OpenSpec Requirements Draft

| Requirement                            | Scenarios                                                                      | Source Evidence                | Notes                                |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------ |
| Advisor availability and configuration | absent/present context, defaults, invalid config                               | tool index/config/tests        | Default model may change.            |
| Advisor input contract                 | invalid question/context, trim, request sections                               | advisor tool/tests             | XML escaping included.               |
| Advisor context isolation              | no implicit transcript, follow-up evidence, return text                        | prior art, tool implementation | Core boundary.                       |
| Advisor nested agent invocation        | create Pi agent, load messages, no assistant, throw                            | advisor tool                   | Missing failure coverage.            |
| Advisor tool subset                    | read-only, mutating, recursion/MCP, recommend mutations                        | advisor tool/tests             | MCP excluded.                        |
| Advisor session persistence            | missing conversation, key, load/save success/failure                           | session store/tests            | Compaction open.                     |
| Advisor prompt policy                  | deep analysis, missing evidence, plan/risks/verification, no user-facing prose | existing spec/tool prompt      | Avoid exact prose freeze.            |
| Advisor failure result shape           | failure, success, executor continuation                                        | advisor tool/existing spec     | Error-shape open.                    |
| Advisor observability                  | span, usage, error status                                                      | advisor tool/tracing spec      | Do not assert telemetry as behavior. |
| Verification taxonomy                  | local, integration, eval                                                       | tests/testing spec             | Evals deferred.                      |

## Migration Notes

- Canonical spec updates:
  - Existing `specs/advisor-tool.md` is already canonical prose; after review, consolidate with the OpenSpec capability.
  - Cross-link to `context-compaction` for advisor history bounding.
  - Cross-link to `mcp-tool-runtime` and auth specs for MCP exclusion.
- Index/pointer updates:
  - Already listed in `specs/index.md` and root `AGENTS.md`; add OpenSpec capability pointer after acceptance.
- Superseded content:
  - Preserve rationale about consultant-not-worker; convert behavior bullets into scenarios.
- Test/eval taxonomy changes:
  - Add missing deterministic failure tests.
  - Add advisor-use evals only after eval taxonomy decides whether use itself or outcome quality is the behavior contract.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-advisor-tool' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: invalid question, missing conversation id, store load/save failures, missing/aborted assistant output, advisor self-exclusion, advisor history compaction, and advisor-use eval taxonomy.
