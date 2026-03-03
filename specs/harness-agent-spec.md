# Harness Agent Spec

This document defines how the Junior harness must run agent turns for Slack replies.

## Loop Model

- Use `ToolLoopAgent` for reply generation.
- Use a bounded stop condition (for example `stepCountIs(100)`) so turns cannot run indefinitely.
- Allow normal assistant markdown completion (do not require a dedicated terminal tool call).

## Terminal Output Contract

- The agent must end each turn with a user-facing assistant markdown response.
- Reply rendering should use assistant text from the turn's generated assistant message(s).

## Streaming Contract

- When streaming text deltas to the user, the harness must insert a newline separator (`"\n"`) between text from consecutive assistant messages within a single turn.
- This matches the non-streamed path's `join("\n")` behavior, so the final rendered output is identical regardless of delivery method.
- The normalizing stream applies `ensureBlockSpacing` to the combined text, expanding single newlines between non-empty paragraphs to double newlines for Slack rendering.

## Visibility Rules

- Intermediate tool calls/results are internal reasoning artifacts. They are not posted directly to users.
- The user-visible reply is the resolved assistant markdown for the turn.
- Slack status updates ("Thinking", rotating assistant statuses) are progress UX only and are not final answers.

## Tool Semantics

- Working tools (`web_search`, `web_fetch`, `bash`, Slack tools, skills, etc.) perform intermediate actions.
- Completion is based on assistant text output, not a dedicated terminal tool.
- Do not rely on provider/tool-only finish states (`finishReason: "tool-calls"`) as a complete user response.

## Tool Target Resolution

- Context-bound tool targets are resolved by harness/runtime context, not model-selected IDs.
- For context-bound tools, tool schemas should not expose destination override fields (for example `channel_id`, `canvas_id`, `list_id`) unless explicitly approved.
- Slack channel operations use active `ToolRuntimeContext.channelId`.
- Canvas/list follow-up operations use artifact context (`lastCanvasId`, `lastListId`, turn-created IDs).
- Missing context must fail safely (`ok: false`) instead of attempting broader/private fallback.
- See [Harness Tool Context Spec](./harness-tool-context-spec.md).

## Execution Scenarios

### Scenario A: Normal Tool + Assistant Response

1. User asks a factual question.
2. Agent calls `web_search` and/or `web_fetch`.
3. Agent receives tool results.
4. Agent emits assistant markdown.
5. Harness posts that markdown to Slack.

Expected: one visible assistant message based on assistant text output.

### Scenario B: Skill-Guided Turn

1. User asks for a task that matches a skill.
2. Agent calls `load_skill`.
3. Agent follows skill instructions; may call other tools.
4. Agent emits assistant markdown.
5. Harness posts the assistant markdown.

Expected: skill/tool steps are internal; only the assistant markdown response is shown.

### Scenario C: Provider Tool-Only Finish

1. Agent calls a provider-executed tool (for example `parallelSearch`).
2. Model step ends with `finishReason: "tool-calls"` and no text.
3. Harness runs bounded continuation/finalization retries.
4. If retries produce assistant text, post it.
5. Otherwise use fallback response and log diagnostics.

Expected: user still gets one final visible reply, not an empty turn.

### Scenario D: Side-Effect Tools + Final Summary

1. Agent creates/updates Slack artifacts (`slack_canvas_*`, `slack_list_*`).
2. Tool side effects happen during the turn.
3. Agent emits assistant markdown summarizing what changed and what to do next.
4. Harness posts that summary.

Expected: side effects plus a clear user-visible wrap-up.

## Fallback Behavior

- If a turn ends with tool calls and no assistant text, run bounded continuation/finalization retries.
- If still missing, return a safe fallback message and log diagnostics.

## Observability

- Every assistant turn must annotate the active turn span with diagnostics after `generateAssistantReply`.
- Required span attributes:
  - `gen_ai.request.model`
  - `gen_ai.provider.name`
  - `gen_ai.operation.name`
  - `gen_ai.input.messages` (when captured)
  - `gen_ai.output.messages` (when captured)
  - `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (when available)
  - `app.ai.outcome` (`success|execution_failure|provider_error`)
  - `app.ai.assistant_messages`
  - `app.ai.tool_results`
  - `app.ai.tool_error_results`
  - `app.ai.used_primary_text`
  - `app.ai.stop_reason` (when available)
  - `error.message` (when available)
- Do not emit empty placeholder values for optional fields; omit absent optional attributes.
- Harness/evals must be able to observe these diagnostics (via span attributes and failure logs).
