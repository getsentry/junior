# Harness Tool Context Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-06-11

## Related Specs

- [Harness Agent Spec](./harness-agent.md)
- [Security Policy](./security-policy.md)

## Purpose

Define how tool execution context is sourced and enforced so model outputs cannot choose privileged or cross-scope targets.

## Scope

- Context-bound Slack channel/list targeting and Canvas creation targeting.
- Runtime-owned source and outbound destination resolution rules.
- Failure behavior for missing or invalid context.
- File-like Slack Canvas document handle semantics.

## Non-Goals

- Provider credential issuance and OAuth flow definitions.
- Other non-context-bound general-purpose tool semantics.

## Core Rule

For context-bound side-effect tools, target selection is owned by the harness/runtime, not by model-provided tool arguments. `source` is the inbound invocation context. `destination` is the default outbound target and is present only for tools or plugin hooks that have an outbound side-effect target.

Examples:

- First-class Slack delivery tools resolve runtime-owned destinations rather than model-supplied targets. `sendMessage` uses `ToolRuntimeContext.source.channelId` and the active source thread/message timestamp because it sends into the active conversation. Canvas create and channel list messages use `ToolRuntimeContext.destination.channelId`. Slack message reactions use `ToolRuntimeContext.source.channelId` and `ToolRuntimeContext.source.messageTs` because they target the current inbound Slack message.
- Plugin tools receive `ToolRegistrationHookContext.source` as Junior's shared inbound context. When an outbound target exists, plugins also receive `ToolRegistrationHookContext.destination`. When `source.platform === "slack"`, plugins receive Slack-specific helper context at `ToolRegistrationHookContext.slack`, including source-channel capabilities and any source-bound credential subject. Local hook contexts must not include `slack`.
- List follow-up operations resolve target artifacts from harness-managed artifact state (`lastListId`, turn-created IDs).
- Slack Canvas document operations use explicit file-like handles (`canvas`). Canvas IDs and URLs may be attempted directly; Slack file permissions and Canvas metadata decide whether the operation can proceed.

## Security Contract

1. Tool schemas for context-bound tools must not expose destination override fields (for example `channel_id` or `list_id`) unless explicitly approved in a separate spec.
2. Runtime must validate context before execution and throw a model-visible tool input error for missing/invalid context.
3. Runtime must not silently fall back to broader/private scopes that change visibility semantics.
4. Canvas creation must stay bound to the active assistant conversation context; runtime must not silently retarget to unrelated/private scopes.
5. Canvas read/edit/write tools must validate that the handle parses as a Slack Canvas/file ID. Canvas reads must confirm Slack metadata describes a Canvas document before downloading content; writes still depend on Slack `canvases.edit` permission and type checks.

## Slack-Specific Targeting Rules

1. Slack side-effect tools use runtime-owned coordinates. `sendMessage` uses the active source conversation and thread/message timestamp; channel-scoped read or artifact tools use `ToolRuntimeContext.destination.channelId`. The model cannot override these coordinates. If required context is absent, outbound tools must not register or must fail with an actionable tool input error.
2. Slack reactions use `ToolRuntimeContext.source.channelId` and `ToolRuntimeContext.source.messageTs`.
3. Canvas creation uses the active Slack outbound destination (`C*`/`G*`/`D*`) without model-provided destination overrides.
4. Canvas read/edit/write tools are document tools: `canvas` is analogous to a file path, accepts a Slack canvas/file ID or URL, and must not expose Slack section IDs or section lookup criteria.
5. Canvas edit uses exact markdown replacements against the current body; Canvas write is explicit full-document replacement. Slack section-scoped mutation APIs are implementation details, not model-facing contracts.
6. List update/read tools use artifact state context, not model-chosen IDs.
7. `slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` must not accept `list_id` input; target list resolution is harness-owned via artifact state.

## Error Behavior

When required context is unavailable, tools must throw an actionable tool input error rather than attempting alternate targets. Tool failures intended for model repair must reach the Pi loop as `toolResult.isError=true`; returning a sentinel object such as `{ ok: false, error }` is not a tool failure.

## Testing Requirements

Integration coverage for context-bound tools must verify:

1. Tool inputs do not include model-selectable destination IDs for context-bound tools.
2. Operations execute against harness-provided context.
3. Missing context fails safely.
4. Canvas document tools validate handles and Slack metadata without enforcing a separate visible-context allowlist.
