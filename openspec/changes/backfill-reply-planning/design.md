# Design: `reply-planning`

## Scope

`reply-planning` owns the deterministic conversion from a completed agent turn result into planned visible reply surfaces. It starts after the agent has emitted messages/tool results and ends before Slack API methods are invoked.

It does not own whether Junior should answer a user at all, the exact model prompt prose, Slack API retry/error mapping, or model judgment about what a user meant.

## Current Boundary

- `turn-result.ts` resolves agent messages/tool calls into an `AssistantReply`, diagnostics, and outcome classification.
- `reply-delivery-plan.ts` decides thread versus channel-only mode and file delivery placement.
- `slack/reply.ts` maps an `AssistantReply` into ordered Slack reply post stages and then delegates API writes.
- `slack/footer.ts` builds finalized reply footer blocks.

## Design Decisions

### Resolve from finalized agent state

Reply planning must use the finalized agent messages and tool results, not streaming deltas. Provisional assistant text before tool results is not a reliable final answer and must not become the visible reply if later tool results change the answer.

### Keep side effects visible without duplicate acknowledgements

Slack side effects such as reactions, explicit channel posts, canvases, and file uploads may satisfy the user without a normal thread reply. Planning should suppress redundant text only when the side effect succeeded and the remaining thread text adds no value. Failed validation or failed side effects must leave an appropriate failure or fallback path.

### Separate planning from outbound API execution

Reply planning may decide stages such as text chunks, inline files, file-only posts, and follow-up file posts. Slack API formatting, upload mechanics, retries, and API error mapping remain owned by outbound delivery specs.

### Treat raw execution payloads as unsafe visible text

If the terminal assistant output is a raw tool payload, execution escape, or other machine-oriented payload, planning must not post it as user-visible assistant text. The turn should become an execution failure unless another validated side effect already satisfied the request.

### Attach finalized metadata only to finalized text

Footer metadata is part of the final Slack reply presentation. It should be added to the last text-bearing chunk and omitted for blank/file-only posts.

## Risks

- Some reply behavior is currently covered indirectly through broad Slack integration tests, making ownership hard to see.
- `ReplyFileDelivery` includes a follow-up mode, but the default delivery-plan builder primarily emits inline or none in inspected paths.
- Channel-only and reaction-only combinations are easy to overspecify. The contract should specify user-visible invariants, not every internal flag combination.

## Open Questions

1. Should file-follow-up mode remain a public reply-planning option if most current paths use inline files?
2. Should provider-error partial text always be posted, or should some provider errors prefer a generic failure message?
3. Should footer placement on multi-chunk replies have direct unit coverage in addition to integration coverage?
4. Should strict versus best-effort file upload failure mode be specified here or only in `slack-outbound-contract`?
