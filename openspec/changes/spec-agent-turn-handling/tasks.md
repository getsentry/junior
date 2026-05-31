## 1. Canonical Spec Publication

- [x] 1.1 Create `specs/agent-turn-handling.md` from the OpenSpec requirements and design, using `specs/spec-template.md` shape and current-date metadata.
- [x] 1.2 Add `specs/agent-turn-handling.md` to `specs/index.md` and its chat/agent/Slack ownership map.
- [x] 1.3 Add `specs/agent-turn-handling.md` to the root `AGENTS.md` known-spec list.
- [x] 1.4 Cross-link related specs from the new spec: `chat-architecture.md`, `slack-agent-delivery.md`, `slack-outbound-contract.md`, `agent-session-resumability.md`, `agent-prompt.md`, `harness-agent.md`, `harness-tool-context.md`, and `testing.md`.

## 2. Prior-Art Alignment Review

- [x] 2.1 Compare the canonical spec against `packages/junior/src/chat/runtime/slack-runtime.ts` for explicit mention, subscribed-message, queued-message, skipped-message, self-message, assistant-lifecycle, and opt-out behavior.
- [x] 2.2 Compare the canonical spec against `packages/junior/src/chat/services/subscribed-decision.ts` for passive routing scenarios, including attachment-backed passive messages, and update either the spec wording or implementation if drift is found.
- [x] 2.3 Compare the canonical spec against `packages/junior/src/chat/prompt.ts` for execution bias, source hierarchy, clarification, Slack side-effect, progress, and failure-handling rules.
- [x] 2.4 Compare the canonical spec against `packages/junior/src/chat/respond.ts` and `packages/junior/src/chat/runtime/reply-executor.ts` for auth pause, timeout continuation, final output, side-effect suppression, and final delivery completion.

## 3. Verification

- [x] 3.1 Read `specs/testing.md` and classify each new or changed check as unit, integration, or eval before adding tests.
- [x] 3.2 Add or confirm deterministic coverage for subscribed-thread preflight/routing guardrails: explicit mention replies, other-party address skips, acknowledgement skips, immediate terse clarification replies, attachment-only classifier routing, opt-out unsubscribes, and classifier low-confidence skips.
- [x] 3.3 Add or confirm integration coverage for queued Slack messages being included in the next eligible turn.
- [x] 3.4 Add or confirm integration coverage for successful Slack side-effect requests avoiding duplicate thread acknowledgements when the side effect already satisfies the request.
- [x] 3.5 Add eval coverage for model-dependent Slackbot behavior: implicit follow-up, side conversation silence, source-backed answer, ask-only-when-blocked, and resumed-turn final-answer-only behavior.

## 4. Validation

- [x] 4.1 Run `pnpm --filter @sentry/junior exec vitest run <targeted test files>` for touched deterministic tests.
- [x] 4.2 Run the relevant eval command for new or changed eval cases.
- [x] 4.3 Run `pnpm typecheck`.
- [x] 4.4 Run `pnpm skills:check`.
- [x] 4.5 Run `openspec validate spec-agent-turn-handling`.
