## Context

Slack ingress routing sits between raw Slack/Chat SDK webhook delivery and Junior's turn runtime. It should normalize Slack payload identity, select the correct runtime entrypoint, preserve queued/skipped user input, and route lifecycle events without deciding whether the model should answer.

Current implementation is split across:

- `JuniorChat`, which wraps Chat SDK processing, normalizes Slack thread IDs before queue key selection, filters external Slack Connect users, and requires `waitUntil` for background webhook work.
- `message-router.ts`, which repairs Slack thread IDs from raw `channel`, `thread_ts`, and `ts` fields and classifies direct messages, subscribed messages, and mentions.
- `message-changed.ts`, which synthesizes a mention message when a Slack `message_changed` event newly adds the bot mention.
- production handler registration, which routes DMs through the mention handler so subscribed DMs cannot be silenced by passive subscribed-message policy.
- `thread-message-dispatcher.ts`, which rehydrates Slack private-file fetchers after Chat SDK queue serialization and dispatches queued messages to the runtime.

Slack prior art matters at the payload boundary. Slack message Events API payloads use `channel`, `ts`, optional `thread_ts`, and optional `subtype`; `message_changed` carries the edited message under `event.message`; bot messages can be detected through bot fields/subtypes; assistant-thread lifecycle events carry `assistant_thread.channel_id` and `assistant_thread.thread_ts`. The Chat SDK adds the concurrency queue, skipped-message context, and handler categories that Junior must map into runtime calls.

## Goals / Non-Goals

**Goals:**

- Specify Slack thread identity normalization before queue/lock selection.
- Specify message-kind routing into mention versus subscribed runtime entrypoints.
- Specify lifecycle, edited-message, external-user, and attachment rehydration ingress behavior.
- Keep ingress behavior separate from passive reply policy, agent execution, and Slack outbound delivery.
- Record open questions where Chat SDK behavior and Junior overrides overlap.

**Non-Goals:**

- Re-specifying passive subscribed-thread reply decisions; see `agent-turn-handling`.
- Re-specifying Slack final delivery, status, markdown, files, or reactions.
- Re-specifying queue retry/locking internals beyond ingress handoff.
- Freezing every raw Slack event subtype.

## Decisions

### Decision: Normalize thread identity before queueing

Junior must repair Slack thread IDs from raw Slack event fields before delegating to the Chat SDK queue. Otherwise a DM root without a thread timestamp and a later reply with the root timestamp can use different queue/state keys for one conversation.

Alternatives considered:

- Normalize inside the runtime after queueing: rejected because the wrong queue key may already have serialized or split work.
- Trust adapter-provided thread ids only: rejected because current Slack DM shapes can arrive incomplete.

### Decision: Keep ingress routing mechanical

Ingress decides which runtime handler should receive a message, not whether the model should answer. Passive reply/no-reply classification belongs to subscribed-thread turn handling. Final delivery belongs to Slack delivery.

Alternatives considered:

- Put passive reply policy in ingress: rejected because ingress lacks durable conversation context and would duplicate runtime policy.
- Treat all subscribed messages as mentions: rejected because subscribed shared-channel threads should remain passive by default.

### Decision: Treat edited-message mentions as synthesized mention turns only when the mention is newly added

Slack `message_changed` events can carry edited message text. Junior should synthesize a mention turn only when the edited text newly includes the bot mention and the previous text did not. This prevents duplicate turns when a message already mentioned Junior and was edited for other reasons.

Alternatives considered:

- Ignore edited mentions entirely: rejected because a user can reasonably add Junior to an existing message.
- Route every edit containing Junior as a new mention: rejected because repeated edits would duplicate turns.

## Risks / Trade-offs

- [Risk] Ingress and turn-handling specs overlap. Mitigation: ingress owns normalization and dispatch; turn-handling owns reply eligibility and model behavior.
- [Risk] Chat SDK internals shift. Mitigation: record assumptions in the worksheet and prefer local tests around Junior's wrapper behavior.
- [Risk] Slack payload docs are broad and subtype behavior varies by subscription. Mitigation: specify only event shapes Junior currently consumes and leave unsupported subtypes undefined unless product behavior requires them.
- [Risk] Attachment fetchers are lost by queue serialization. Mitigation: dispatcher and production handlers rehydrate fetchers before runtime entrypoints.

## Open Questions

- Should `determineThreadMessageKind(...)` itself prefer direct messages over subscribed status, matching production `onDirectMessage`, or remain generic with production registration as the DM override?
- Should `message_changed` mention extraction stay as ingress code or be moved closer to the Slack adapter?
- Which Slack event subtypes should be explicitly ignored versus left to adapter defaults?
- Should external Slack Connect user filtering be configurable per workspace?
- Which Chat SDK payload guarantees should be copied into a local reference to avoid relying on scattered comments?

## Migration Plan

1. Validate this OpenSpec change.
2. Review overlap with `agent-turn-handling` and `chat-architecture`.
3. After acceptance, archive this capability into `openspec/specs/slack-ingress-routing/spec.md`.
4. Use the verification map to split or rename tests that currently live under broader Slack behavior suites.
