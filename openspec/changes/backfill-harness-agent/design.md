## Context

`generateAssistantReply(...)` is Junior's Pi execution harness. It constructs a Pi `Agent`, selects thinking level, restores session messages when needed, subscribes to Pi text events, runs `prompt()` or `continue()`, handles timeout/auth/provider retry paths, then delegates final output resolution to `buildTurnResult(...)`.

The current code and tests show a clean boundary:

- Harness output is an `AssistantReply` with text/files/artifact patch/delivery plan/diagnostics.
- Slack-visible delivery success is decided later by Slack runtime specs.
- Provisional assistant text before the last tool result is not terminal output.
- Side-effect-only Slack actions can be successful without thread text, but the Slack delivery planner owns final visible artifacts.

## Goals / Non-Goals

**Goals:**

- Specify Pi loop behavior, output resolution, streaming callback handling, timeout/provider retry behavior, and diagnostics.
- Keep harness concerns separate from Slack posting, OAuth credentials, provider-specific tools, and prompt ownership.
- Record verification gaps without adding tests in this spec-only change.

**Non-Goals:**

- Rewriting Pi integration.
- Re-specifying Slack final delivery or outbound transport.
- Re-specifying tool schemas or context-bound Slack/tool targeting.
- Making telemetry/log output a behavior contract beyond structured diagnostics.

## Decisions

### Decision: Final output is terminal assistant text after tool results

The harness should ignore pre-tool narration and assemble terminal assistant messages after the last tool-result boundary. This matches `buildTurnResult(...)` and prevents provisional process text from becoming the final answer.

### Decision: Streaming is an optional preview channel

Pi `message_update` / `text_delta` events are forwarded to callbacks, but callback failures are logged and do not fail the harness turn. Final resolved output remains authoritative.

### Decision: Timeout resumability belongs to session spec after harness detection

The harness detects timeout, aborts Pi, waits for settlement, snapshots messages, and either throws retryable resume metadata or falls back to provider-error output. Scheduling, callbacks, and Slack continuation notices belong to session/delivery specs.

## Risks / Trade-offs

- [Risk] Harness spec overlaps with Slack delivery. Mitigation: final reply posting and persistence-after-delivery stay in Slack delivery/runtime specs.
- [Risk] Diagnostics are treated as telemetry assertions. Mitigation: specify diagnostics on `AssistantReply`; avoid requiring log/span mocks.
- [Risk] Side-effect-only success blurs harness vs delivery. Mitigation: harness can mark success and delivery plan; Slack planner owns artifacts.

## Open Questions

- Should streaming newline behavior use one newline or two between assistant messages to match final join exactly?
- Should `buildTurnResult(...)` remain the owner of Slack side-effect-only delivery planning, or should that move fully to reply planning?
- Should thinking-level routing be a separate capability spec if classifier behavior grows?
- Which diagnostics fields are API-stable versus footer/observability implementation detail?

## Migration Plan

1. Validate this OpenSpec change.
2. Review overlap with `agent-session-resumability` and `slack-agent-delivery`.
3. After acceptance, archive this capability into `openspec/specs/harness-agent/spec.md`.
4. Use verification map gaps for later focused test/eval cleanup.
