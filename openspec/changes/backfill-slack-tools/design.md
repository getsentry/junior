# Design: `slack-tools`

## Scope

`slack-tools` owns model-callable Slack actions and reads. It starts when a Slack tool definition receives model arguments and turn context, and ends when it returns a tool result or expected tool failure.

It does not own Slack Web API retry/error mapping, final assistant reply delivery, generic Pi tool wrapping, or natural-language decisions about whether a tool should be used.

## Slack Prior Art

- Slack reaction APIs operate on a concrete channel and message timestamp; Junior binds both from runtime context for the current inbound message.
- Slack channel posting and channel history APIs operate on Slack conversation IDs; Junior exposes channel tools only when the active context supports those channel operations.
- Slack Canvases are documents that can be created/edited through Canvas APIs using markdown `document_content`; Slack supports h1-h3 headings and a defined markdown subset.
- Slack Lists APIs require list IDs and rich field payloads; Junior hides `list_id` from the model for follow-up operations and resolves it from artifact state.

## Design Decisions

### Runtime owns Slack targets

Context-bound Slack tools must not let the model pick arbitrary destination channels, messages, or active list IDs. The runtime injects active channel/message/list/canvas context.

### Tool-family semantics sit above outbound APIs

Slack tools decide whether the action is allowed, which active artifact to target, what state to patch, and whether a duplicate side effect should be deduped. The outbound Slack contract owns API call validation, retries, idempotent Slack API errors, and request shape.

### Canvas tools behave like document/file tools

Canvas read/edit/write accept a canvas/file handle, validate it as a Canvas document, read bounded markdown, and apply exact edits or full replacements. They do not expose Slack section IDs to the model.

### List follow-ups use artifact state

List add/get/update tools operate on the current list tracked in artifact state. They do not accept model-provided `list_id`, because list targeting is harness-owned.

### Classify `ok:false` results under the shared tool-error rule

Several existing tools return `{ ok: false, error }`. Under `tool-execution`, repairable missing context, invalid input, or unsupported state must become `ToolInputError` or an equivalent expected tool error. Slack read tools may still return successful structured "no messages", "not found", or "not accessible" domain data only when the tool-family spec explicitly treats that answer as the result of a successful read.

## Risks

- Slack Lists APIs were publicly introduced recently and may still evolve.
- Current channel/private-thread read rules rely on local ID prefixes and bot access outcomes.
- Canvas read relies on `files.info` and private file download because there is no direct structured canvas-read API in current implementation.
- Unclassified sentinel failure payloads can cause the model to treat repairable tool failures as successful observations.

## Open Questions

1. Which Slack `{ ok:false }` results are repairable failures that must convert to `ToolInputError`, and which are legitimate read-domain negative results that should remain successful data?
2. Should channel history reads be available in DMs or only in shared channel contexts?
3. Should canvas create remain available in DMs through channel access grants?
4. Should list tools include stronger durable idempotency beyond turn-local operation keys?
