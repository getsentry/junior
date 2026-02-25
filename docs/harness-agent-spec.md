# Harness Agent Spec

This document defines how the Junior harness must run agent turns for Slack replies.

## Loop Model

- Use `ToolLoopAgent` for reply generation.
- Use a bounded stop condition: `stopWhen: [hasToolCall("final_answer"), stepCountIs(100)]`.
- Use `toolChoice: "required"` so each step is an explicit tool decision.

## Terminal Output Contract

- The agent must end each turn by calling `final_answer`.
- `final_answer` is a terminal tool with **no** `execute` function.
- `final_answer.input.answer` contains the final user-facing markdown response.
- Reply rendering should prefer `final_answer.input.answer` over `result.text`.

## Visibility Rules

- Intermediate tool calls/results are internal reasoning artifacts. They are not posted directly to users.
- The user-visible reply for the turn is the extracted `final_answer.input.answer`.
- If `final_answer` is missing, the harness may use fallback `result.text`, then final fallback copy.
- Slack status updates ("Thinking", rotating assistant statuses) are progress UX only and are not final answers.

## Tool Semantics

- Working tools (`web_search`, `web_fetch`, `bash`, Slack tools, skills, etc.) perform intermediate actions.
- `final_answer` is the only canonical completion signal for a turn.
- Do not rely on provider/tool-only finish states (`finishReason: "tool-calls"`) as a complete user response.

## Execution Scenarios

### Scenario A: Normal Tool + Final Answer

1. User asks a factual question.
2. Agent calls `web_search` and/or `web_fetch`.
3. Agent receives tool results.
4. Agent calls `final_answer` with markdown in `input.answer`.
5. Harness posts `input.answer` to Slack.

Expected: one visible assistant message, based on `final_answer`.

### Scenario B: Skill-Guided Turn

1. User asks for a task that matches a skill.
2. Agent calls `load_skill`.
3. Agent follows skill instructions; may call other tools.
4. Agent calls `final_answer`.
5. Harness posts `final_answer.input.answer`.

Expected: skill/tool steps are internal; only final answer is shown.

### Scenario C: Provider Tool-Only Finish

1. Agent calls a provider-executed tool (for example `parallelSearch`).
2. Model step ends with `finishReason: "tool-calls"` and no text.
3. Harness runs bounded continuation/finalization retries.
4. If retries produce `final_answer`, post it.
5. Otherwise use fallback response and log diagnostics.

Expected: user still gets one final visible reply, not an empty turn.

### Scenario D: Side-Effect Tools + Final Summary

1. Agent creates/updates Slack artifacts (`slack_canvas_*`, `slack_list_*`).
2. Tool side effects happen during the turn.
3. Agent calls `final_answer` summarizing what changed and what to do next.
4. Harness posts that summary.

Expected: side effects plus a clear user-visible wrap-up.

## Fallback Behavior

- If a turn ends with tool calls and no `final_answer`, run bounded continuation/finalization retries.
- If still missing, return a safe fallback message and log diagnostics.

## Observability

- Every assistant turn must emit one `agent_turn_diagnostics` log event after `generateAssistantReply`.
- The event must include:
  - `gen_ai.request.model`
  - `gen_ai.system`
  - `gen_ai.operation.name`
  - `app.ai.outcome` (`success|execution_failure|provider_error`)
  - `app.ai.assistant_messages`
  - `app.ai.tool_results`
  - `app.ai.tool_error_results`
  - `app.ai.used_final_answer`
  - `app.ai.used_primary_text`
  - `app.ai.stop_reason` (when available)
  - `error.message` (when available)
- Do not emit empty placeholder values for optional fields; omit absent optional attributes.
- Harness/evals must be able to observe these diagnostics (directly or via mapped warning events).
