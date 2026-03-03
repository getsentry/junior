# Harness Tool Context Spec

## Purpose

Define how tool execution context is sourced and enforced so model outputs cannot choose privileged or cross-scope targets.

## Core Rule

For context-bound tools, target selection is owned by the harness/runtime, not by model-provided tool arguments.

Examples:
- Slack channel operations resolve destination from `ToolRuntimeContext.channelId`.
- Canvas/list follow-up operations resolve target artifacts from harness-managed artifact state (`lastCanvasId`, `lastListId`, turn-created IDs).

## Security Contract

1. Tool schemas for context-bound tools must not expose destination override fields (for example `channel_id`, `canvas_id`, `list_id`) unless explicitly approved in a separate spec.
2. Runtime must validate context before execution and return `ok: false` for missing/invalid context.
3. Runtime must not silently fall back to broader/private scopes that change visibility semantics.
4. Canvas creation must stay bound to the active assistant conversation context; runtime must not silently retarget to unrelated/private scopes.

## Slack-Specific Targeting Rules

1. Channel-scoped Slack tools use the active harness channel context.
2. Canvas creation uses the active conversation context (`C*`/`G*`/`D*` channel scope) without model-provided destination overrides.
3. Canvas/list update/read tools use artifact state context, not model-chosen IDs.
4. `slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` must not accept `list_id` input; target list resolution is harness-owned via artifact state.

## Error Behavior

When required context is unavailable, tools should return actionable structured errors (`ok: false`) rather than attempting alternate targets.

## Testing Requirements

Integration coverage for context-bound tools must verify:
1. Tool inputs do not include model-selectable destination IDs for context-bound tools.
2. Operations execute against harness-provided context.
3. Missing context fails safely.
4. Disallowed fallback targets (for example context-less or cross-thread canvases) are not invoked.
