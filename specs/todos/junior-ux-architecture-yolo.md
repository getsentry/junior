# Junior UX + Architecture YOLO TODO

- [x] Extract subscribed-thread routing into `src/chat/routing/subscribed-decision.ts`
- [x] Add deterministic pre-rules before classifier (mention/ack/follow-up heuristics)
- [x] Introduce `SubscribedReplyReason` enum and migrate call sites
- [x] Add unit tests for routing decisions and reasons
- [x] Add `ReplyDeliveryPlan` in `src/chat/delivery/plan.ts`
- [x] Refactor delivery behavior for thread/channel/reaction/files consistency
- [x] Fix streamed + files edge path (no noisy duplicate follow-up text)
- [x] Add integration tests for delivery edge cases
- [x] Implement Status V1 safe pass (dedupe + debounce + min-visible-duration)
- [x] Add deterministic status tests for burst and reordering scenarios
- [x] Split `replyToThread` into turn modules under `src/chat/turn/*`
- [x] Keep behavior stable while decomposing orchestration
- [x] Tighten prompt/runtime contract boundaries in `src/chat/prompt.ts`
- [x] Add concise comments for non-obvious orchestration/routing logic
- [x] Add/expand conversational evals for routing + delivery + status UX
- [x] Run `pnpm test`
- [ ] Run `pnpm evals` (skipped per user request)
- [x] Final review pass + update TODO file with outcomes

## Validation summary

- `pnpm typecheck`: pass
- `pnpm test`: pass (67 files, 326 tests)
- `pnpm evals`: intentionally skipped per user request
