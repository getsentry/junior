# Advisor Tool Spec

## Metadata

- Created: 2026-05-06
- Last Edited: 2026-05-28

## Purpose

Define Junior's provider-agnostic `advisor` tool: a stronger Pi Agent exposed as a normal tool for hard planning, debugging, architecture, and review. The main executor stays in control of edits, verification, and user-visible output.

The core contract is intentionally small:

- The executor calls `advisor({ question, context })`.
- The advisor gets its own conversation-scoped Pi message history.
- The executor passes the current evidence explicitly; the parent transcript is not forked or implicitly forwarded.
- The advisor can use tools from the normal tool layer that are annotated read-only, but not recursive, write, or user-visible tools.
- The advisor returns guidance; it does not own implementation.

## Non-Goals

- Forking the main transcript into a hidden advisor conversation.
- Maintaining replay hashes, call records, idempotency bookkeeping, or per-turn call counters.
- Building a general multi-agent orchestration framework.
- Adding a separate read-only tool sandbox in V1. The advisor receives the host-filtered read-only tool subset; the executor remains responsible for side effects.
- Exposing MCP tools to the advisor without a separate nested-agent auth and resume contract.

## Configuration

The production chat config enables the advisor by default.

Environment settings:

- `AI_ADVISOR_MODEL`, default `openai/gpt-5.5`
- `AI_ADVISOR_THINKING_LEVEL`, default `xhigh`

Invalid advisor model ids and thinking levels fail at config load.

## Tool Surface

Tool name: `advisor`

Input:

- `question`: required focused advisor question or decision point.
- `context`: required curated evidence packet with the requirements, constraints, current plan, alternatives, code snippets, diffs, command output, and open questions the advisor should start from.

The tool description is the executor-facing trigger policy. It must say the advisor is stronger, tool-backed, does not automatically receive the parent transcript, keeps advisor history for the parent conversation, receives a read-only tool subset, and is for hard reasoning rather than routine work.

## Runtime Contract

1. Validate that `question` and `context` are non-empty strings after trimming.
2. Build one advisor request message with `<advisor-task>` and `<executor-context>` sections.
3. Load advisor messages from `junior:<conversationId>:advisor_session`.
4. Create a Pi `Agent` with the advisor model, thinking level, system prompt, and advisor-allowed tools.
5. Expose only read-only tool definitions to the advisor. A tool is advisor-readable only when `readOnlyHint: true` and `destructiveHint` is not `true`. Do not expose recursive, write, user-visible, or unconstrained external-action tools.
6. Assign the loaded messages to `advisorAgent.state.messages`.
7. Run `advisorAgent.prompt(requestMessage)`.
8. On success, save `advisorAgent.state.messages` back to the advisor session key.
9. Return the advisor's text exactly as produced in the tool result.

If `conversationId` is unavailable, return `missing_conversation_id`; do not create an orphan advisor session.

## Advisor State

Advisor state is scoped to the parent conversation id and must survive process restarts and later request lifecycles.

- Store key: `junior:<conversationId>:advisor_session`
- Stored value: the advisor agent's own `PiMessage[]`
- TTL: same as Junior's one-week thread-state TTL

The main Pi transcript stores only the bounded tool result object from normal Pi tool execution, not the advisor's private history.

## Advisor Prompt

The advisor system prompt must frame the advisor as a senior technical reviewer for the executor.

It must require the advisor to:

- Analyze the executor-supplied context deeply.
- Use tools when inspection or verification would materially improve the advice.
- Distinguish evidence from inference.
- Avoid assuming access to parent transcript or tool output that was not supplied or gathered in the advisor run.
- Use only tools annotated as read-only.
- Avoid user-visible side effects and file mutation; recommend mutating actions to the executor instead.
- Identify the hard part, recommend a concrete plan or correction, call out blocking risks, and propose focused verification.
- Say what evidence is missing when the supplied context is insufficient.
- Avoid user-facing prose.

## Failures

All advisor failures are non-fatal to the main executor. The tool returns `ok: false` and `error_code`.

Stable `error_code` values:

- `invalid_context`
- `invalid_question`
- `missing_conversation_id`
- `session_unavailable`
- `unavailable`

## Telemetry

The advisor runtime emits a nested `ai.invoke_advisor` span with:

- `gen_ai.provider.name`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- native span status
- standard usage attributes when provider usage is available

Do not add custom outcome/result attributes when native span status or standard usage attributes already represent the fact.

## Verification

Coverage must prove:

- advisor config defaults, overrides, and invalid config handling
- tool exposure only when advisor runtime context is configured
- explicit executor context reaches the advisor
- advisor receives read-only tools while write and user-visible tools are excluded
- advisor messages persist and restore across calls in the same parent conversation

## References

- `./testing.md`
- `./agent-execution.md`
- `./agent-session-resumability.md`
