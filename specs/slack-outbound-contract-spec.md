# Slack Outbound Contract Spec

## Metadata

- Created: 2026-04-16
- Last Edited: 2026-04-16

## Changelog

- 2026-04-16: Initial canonical contract for Slack outbound operations and reply-text translation ownership.

## Status

Active

## Purpose

Define the canonical outbound contract for Slack in Junior so message posting, file uploads, reaction behavior, and reply-text translation are implemented once and verified once.

This spec exists to prevent Slack outbound behavior from being duplicated across handlers, runtime code, tool modules, and resume paths.

## Scope

- Direct Slack Web API outbound operations used by Junior (`chat.postMessage`, `chat.postEphemeral`, file uploads, reactions)
- Ownership boundary between reply-text translation and Slack delivery
- Input validation, idempotence, and retry/error semantics for outbound Slack actions
- Required test split for Slack outbound behavior versus broader runtime behavior

## Non-Goals

- Re-specifying inbound Slack routing or assistant-thread lifecycle behavior
- Replacing the user-visible delivery rules in `slack-agent-delivery-spec.md`
- Defining Chat SDK adapter internals
- Converting arbitrary CommonMark into full-fidelity Slack rendering for every markdown feature

## Contracts

### 1. Boundary Ownership

Slack outbound behavior is split into two explicit boundaries:

1. `packages/junior/src/chat/slack/output.ts` owns reply-text translation from model-authored markdown into Slack-friendly `mrkdwn`, plus continuation/interruption markers and reply chunking.
2. `packages/junior/src/chat/slack/outbound.ts` owns direct Slack Web API writes for message posts, ephemeral posts, file uploads, and reactions.
3. Callers must not duplicate Slack outbound behavior with direct `getSlackClient().chat.postMessage(...)`, `chat.postEphemeral(...)`, `filesUploadV2(...)`, or `reactions.*(...)` outside `slack/outbound.ts`.
4. Delivery modules must send already-rendered Slack text and must not apply their own Slack formatting rules after `slack/output.ts` has rendered it.

### 2. Reply-Text Translation Contract

Current rules:

1. Prompting should target Slack-friendly markdown, not generic full CommonMark.
2. `slack/output.ts` is the only canonical place to normalize line endings, block spacing, and reply chunk boundaries for Slack replies.
3. Continuation markers and interruption markers are delivery-time annotations owned by `slack/output.ts`, not model-authored text.
4. If future markdown-to-`mrkdwn` adaptations are needed, they must be added in `slack/output.ts` rather than scattered across delivery callers.

### 3. Message Posting Contract

Current rules:

1. Message posting must normalize Slack conversation IDs before calling Slack.
2. Message posting must reject empty text.
3. Message posting must reject text above 40,000 characters instead of relying on Slack truncation.
4. Thread replies pass `thread_ts`; channel posts omit it.
5. Channel permalink lookup is best effort and must not turn a successful post into a failed action.
6. Slack message posts use `text` with `mrkdwn` enabled; callers do not switch between competing text fields ad hoc.

### 4. Ephemeral Message Contract

Current rules:

1. Ephemeral delivery goes through the shared outbound boundary instead of ad hoc handler calls.
2. Ephemeral posts require a concrete channel ID, user ID, and non-empty text.
3. Slack's documented ephemeral non-durability is part of the product constraint; callers may fall back to DM delivery when in-context private delivery fails.

### 5. File Upload Contract

Current rules:

1. Thread file uploads go through the shared outbound boundary.
2. Uploads require a valid channel ID, thread timestamp, and at least one file.
3. Each file must include a filename before the upload request is built.
4. Resume and callback flows use the same upload semantics as the primary reply planner.

### 6. Reaction Contract

Current rules:

1. Reaction operations normalize emoji input to Slack alias format before sending.
2. `already_reacted` is treated as idempotent success for add-reaction operations.
3. `no_reaction` is treated as idempotent success for remove-reaction operations.
4. Other Slack reaction failures still surface as action failures.

### 7. Retry and Error Mapping Contract

Current rules:

1. Slack rate limits are retried through `withSlackRetries`.
2. Permanent Slack API failures are mapped into `SlackActionError` codes before surfacing.
3. Error mapping must preserve the Slack API error string when available so callers and logs can distinguish specific platform failures.
4. Idempotent success cases (`already_reacted`, `no_reaction`) are mapped explicitly so outbound callers can handle them intentionally.

## Failure Model

1. Invalid local inputs (missing channel IDs, empty text, empty file batches, invalid emoji aliases) fail before Slack is called.
2. Rate-limited Slack writes may be retried.
3. Non-retryable Slack failures surface as `SlackActionError` values unless the contract explicitly defines them as idempotent success.
4. Best-effort follow-on work, such as permalink lookup, must not retroactively fail a successful message post.

## Observability

Slack outbound behavior relies on `withSlackRetries` for action/error logging.

Required observability shape:

- `app.slack.action` identifies the outbound Slack method family being executed.
- Mapped Slack error codes remain visible through `app.slack.error_code` and `app.slack.api_error` when present.
- Retry logging distinguishes retried rate limits from terminal failures.

## Verification

Required verification coverage for this contract:

1. Unit: outbound-boundary validation and reaction idempotence.
2. Unit: error mapping for Slack outbound-specific API errors.
3. Integration: message-post request shape and permalink lookup behavior.
4. Integration: file upload request flow and validation edges.
5. Integration: reaction request shape and `already_reacted` success semantics.
6. Runtime behavior tests continue to verify reply planning separately from raw Slack request details.

## Related Specs

- `./slack-agent-delivery-spec.md`
- `./chat-architecture-spec.md`
- `./oauth-flows-spec.md`
- `./testing/index.md`
