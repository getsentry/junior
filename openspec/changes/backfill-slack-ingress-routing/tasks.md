## 1. Source Inventory

- [x] 1.1 Review `specs/chat-architecture.md`, `specs/agent-turn-handling.md`, `specs/slack-agent-delivery.md`, and `specs/testing.md`.
- [x] 1.2 Inspect Slack ingress paths: `message-router.ts`, `junior-chat.ts`, `message-changed.ts`, `workspace-membership.ts`, production handler registration, queue dispatcher, and Slack runtime entrypoints.
- [x] 1.3 Inventory unit/integration coverage for routing classification, thread ID normalization, edited-message mentions, assistant lifecycle events, direct messages, queued/skipped messages, and attachment rehydration.
- [x] 1.4 Review prior art from Slack Events API docs, Slack assistant-thread events, Slack message subtype docs, and Chat SDK queue/payload behavior recorded in local fixtures and skill guidance.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-slack-ingress-routing`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `slack-ingress-routing`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare OpenSpec requirements with `specs/chat-architecture.md` and `specs/agent-turn-handling.md` to remove any duplicate ownership.
- [ ] 3.2 Decide whether `determineThreadMessageKind` should remain subscribed-first for generic classification while production explicitly routes DMs through `onDirectMessage`.
- [ ] 3.3 Decide whether edited-message mention extraction should live permanently in ingress or move into a Slack adapter wrapper.
- [ ] 3.4 Decide which Chat SDK payload assumptions need local reference docs versus external links.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map Slack ingress tests that currently live under broader behavior suites to this capability.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-slack-ingress-routing`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
