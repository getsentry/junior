# Backfill Worksheet: `slack-agent-delivery`

## Scope

- Capability: Slack agent delivery
- Change: `backfill-slack-agent-delivery`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/slack-agent-delivery/spec.md` after review; current prose source remains `specs/slack-agent-delivery.md`

## Current-Source Inventory

### Existing Specs And Policies

- `specs/slack-agent-delivery.md`: primary existing contract for Slack entry surfaces, status, replies, continuation, files, images, and resume delivery.
- `specs/slack-outbound-contract.md`: direct Slack Web API write boundary, message blocks/fallback text, file upload, reaction idempotence, retry/error mapping.
- `specs/agent-turn-handling.md`: response policy, turn completion, side-effect-only reply handling, and tool behavior boundaries.
- `specs/agent-session-resumability.md`: durable session record and timeout continuation mechanics.
- `specs/chat-architecture.md`: module ownership and service/runtime boundaries.
- `specs/testing.md`: unit/integration/eval layer rules.

### Code Paths

- `packages/junior/src/chat/runtime/slack-runtime.ts`: Slack event entry points and handler orchestration.
- `packages/junior/src/chat/runtime/reply-executor.ts`: live Slack turn execution, assistant status, final reply delivery, auth pause, timeout continuation, state commit.
- `packages/junior/src/chat/runtime/slack-resume.ts`: resumed Slack turn execution, locking, status, reaction, final reply delivery, and resume failure handling.
- `packages/junior/src/chat/runtime/processing-reaction.ts`: automatic `eyes` lifecycle and model-added reaction preservation.
- `packages/junior/src/chat/runtime/thread-context.ts`: Slack thread/channel/timestamp extraction for delivery.
- `packages/junior/src/chat/slack/reply.ts`: reply planning to Slack posts, footer placement, API-post path, file attachment delivery.
- `packages/junior/src/chat/slack/output.ts`: Slack mrkdwn rendering, reply budget, continuation/interruption markers, code-fence preservation.
- `packages/junior/src/chat/slack/outbound.ts`: direct Slack Web API writes and normalization.
- `packages/junior/src/chat/slack/assistant-thread/status*.ts`: assistant status formatting, scheduling, token binding, Web API/adaptor senders.
- `packages/junior/src/chat/slack/assistant-thread/lifecycle.ts`: assistant-thread title, prompts, source-channel context.
- `packages/junior/src/chat/slack/assistant-thread/title.ts`: conversation-specific title generation and update.
- `packages/junior/src/chat/services/reply-delivery-plan.ts`: thread/channel/file delivery plan and redundant reaction ack detection.
- `packages/junior/src/chat/services/vision-context.ts`: Slack image hydration and persisted image summaries.
- `packages/junior/src/chat/services/auth-pause-response.ts`: public auth-pause acknowledgement text.
- `packages/junior/src/chat/slack/turn-continuation-notice.ts`: durable timeout-continuation acknowledgement.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/slack/status-format.test.ts`
  - `packages/junior/tests/unit/slack/footer.test.ts`
  - `packages/junior/tests/unit/slack/footer-sentry-link.test.ts`
  - `packages/junior/tests/unit/slack/thread-id-normalization.test.ts`
  - `packages/junior/tests/unit/slack/message-changed-ingress.test.ts`
  - `packages/junior/tests/unit/delivery/plan.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/bot-handlers.test.ts`
  - `packages/junior/tests/integration/slack/new-mention-behavior.test.ts`
  - `packages/junior/tests/integration/slack/subscribed-message-behavior.test.ts`
  - `packages/junior/tests/integration/slack/finalized-reply-behavior.test.ts`
  - `packages/junior/tests/integration/slack/processing-reaction-behavior.test.ts`
  - `packages/junior/tests/integration/slack/assistant-lifecycle-behavior.test.ts`
  - `packages/junior/tests/integration/slack/assistant-lifecycle-contract.test.ts`
  - `packages/junior/tests/integration/slack/assistant-status-auth-contract.test.ts`
  - `packages/junior/tests/integration/slack/outbound-normalization-contract.test.ts`
  - `packages/junior/tests/integration/slack/file-delivery-behavior.test.ts`
  - `packages/junior/tests/integration/slack/attachment-behavior.test.ts`
  - `packages/junior/tests/integration/slack/attachment-media-behavior.test.ts`
  - `packages/junior/tests/integration/slack/bot-image-hydration.test.ts`
  - `packages/junior/tests/integration/slack/message-im-attachment-contract.test.ts`
  - `packages/junior/tests/integration/slack/message-changed-behavior.test.ts`
  - `packages/junior/tests/integration/slack/message-changed-reply-contract.test.ts`
  - `packages/junior/tests/integration/oauth-resume-slack.test.ts`
  - `packages/junior/tests/integration/turn-resume-slack.test.ts`
  - `packages/junior/tests/integration/oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
  - `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/slack-file-upload.test.ts`
- Evals:
  - Existing evals may cover Slack reply quality, routing, and tool-choice behavior, but they should be mapped during `eval-testing` / `agent-turn-handling` backfill rather than treated as Slack transport coverage by filename.
- Fixtures/MSW:
  - `packages/junior/tests/fixtures/slack/*`
  - `packages/junior/tests/msw/handlers/slack-api.ts`

### Package Docs And Scripts

- `packages/junior-evals/README.md`: eval layer expectations.
- Root `AGENTS.md`: Slack-specific runtime rules and known-spec pointers.
- File-scoped command pattern: `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`.

## Prior Art

- Platform or API docs:
  - Slack `assistant_thread_started`: event includes `assistant_thread.channel_id`, `thread_ts`, `user_id`, and optional context; Slack recommends listening for `assistant_thread_context_changed` as user context changes.
  - Slack Assistant guides: assistant apps can handle lifecycle events and `message.im`; context may need app-owned storage because later user messages do not include the same context.
  - Slack `assistant.threads.setStatus`: supports `status` and optional `loading_messages`, automatically clears status when the app replies, and accepts empty status to clear.
  - Slack `chat.postMessage`: `thread_ts` makes a message a reply; top-level `text` is the fallback for notifications/accessibility when blocks are present; Slack truncates overly long posts.
  - Slack file upload docs: legacy `files.upload` is deprecated/sunset; thread file delivery should be expressed as product semantics rather than by legacy method name.
- SDK/source references:
  - Current repo adapter uses `setAssistantStatus`, `setAssistantTitle`, `setSuggestedPrompts`, `thread.post`, and `filesUploadV2` through local boundaries.
- Comparable product or agent behavior:
  - Slack, Teams, and Discord-style agents commonly distinguish transient typing/loading state from durable thread messages. For Junior, durable correctness is final thread reply delivery.
- Notes on applicability:
  - Slack docs constrain API fields and lifecycle events; Junior product policy decides when status is best effort, how replies are chunked, and when state commits.

## Implemented Behavior

- Behavior that code currently enforces:
  - Explicit mentions/DMs and subscribed follow-ups flow through separate runtime paths.
  - Assistant lifecycle sets title/prompts and preserves source-channel context.
  - Assistant status sessions normalize channel IDs, bind bot token for delayed updates, use stable status plus loading messages, debounce/schedule updates, and log failures.
  - Processing reaction adds/removes `eyes` best effort and preserves explicit assistant-added `eyes`.
  - Final visible Slack text is posted after final reply planning, not from provisional deltas.
  - Reply posts are chunked under a 2200-character / 45-line budget with continuation and interruption markers.
  - Code fences are closed/reopened across continuation boundaries.
  - Footer metadata is attached to the final text chunk for direct Slack API footer path.
  - File-only replies produce a visible artifact; files are included in final delivery planning.
  - Resume delivery uses shared Slack reply planning and treats final delivery failure as resume failure.
  - Image attachments are hydrated or represented as unavailable-vision context.
- Behavior that tests currently verify:
  - Finalized replies ignore deltas and post final answer once.
  - Long replies split with continuation markers and preserve fenced code.
  - Provider-error partial replies include interruption markers.
  - File-only and suppressed-text file plans still post files.
  - Assistant status binds active Slack token and sends loading messages.
  - Assistant lifecycle normalizes adapter-scoped channel IDs.
  - Processing reaction timing differs for mentions versus subscribed messages.
  - OAuth/resume paths post status, chunks, footers, and files through Slack API harness.
- Behavior that appears accidental or weakly enforced:
  - Exact status timing/debounce intervals are implementation policy, not clearly product-level.
  - Some resume public acknowledgement copy may conflict with the canonical no-public-connected-banner rule.
  - Test names mix behavior and transport contracts in places.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Slack progress is best effort and transient; final visible reply delivery is durable and turn-success-defining.
  - Slack thread posts are the primary reply surface; streaming text is not a correctness requirement.
  - Resume and live delivery share reply planning semantics.
  - Attachments/images are part of the user turn context and cannot be dropped by skipped or deserialized paths.
  - Slack status/footer/reaction/file behavior must be observable enough to debug delivery issues.
- Behavior that should remain implementation detail:
  - Specific debounce durations and random loading-message rotation order.
  - Exact internal service names and helper function names.
  - Specific Slack SDK upload method, as long as user-visible thread file delivery and outbound contract are satisfied.
- Behavior that should be non-goal:
  - Full CommonMark fidelity in Slack rendering.
  - Slack-native visible text streaming.
  - Model reply quality and natural-language routing criteria.
  - OAuth token security and provider credential semantics.

## Undefined Behavior / Open Questions

| Question                                                  | Evidence                                                                                                                                | Options                                                                                     | Recommendation                                                                                | Status |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| Should exact status debounce/refresh timing be normative? | Spec says debounce/refresh; code has scheduler constants; Slack docs specify status clearing behavior, not Junior timing.               | Specify exact timing, specify bounds, or keep as implementation policy.                     | Specify behavior-level requirements only unless product wants SLA-like timing.                | open   |
| Should footer fields be fixed?                            | Current footer includes ID, thinking, tokens, duration when available; spec says "may be shown".                                        | Fix exact fields or require structured final metadata only.                                 | Keep field set configurable/conditional; require final-chunk placement and structured source. | open   |
| Should canonical docs mention `files.upload`?             | Slack docs mark legacy `files.upload` as deprecated/sunset; code uses `filesUploadV2`.                                                  | Rename to file delivery semantics or pin to current SDK flow.                               | Avoid legacy API names in delivery spec; leave transport primitive to outbound spec.          | open   |
| Should OAuth resume public `connectedText` remain?        | Existing tests assert a visible connected banner; canonical prose says automatic auth resumes should not post a separate public banner. | Preserve banner, remove banner, or allow only explicit/manual resumes.                      | Treat as open mismatch for follow-up; do not resolve in spec-only backfill.                   | open   |
| What happens when channel-only reply also has files?      | Current planner can still produce file artifact when files remain inline.                                                               | Always thread-deliver files, suppress all thread artifacts, or require explicit plan field. | Keep current behavior: files remain visible unless delivery plan excludes them.               | open   |

## OpenSpec Requirements Draft

| Requirement                         | Scenarios                                                                      | Source Evidence                                                                                                | Notes                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Slack entry surfaces                | DM, mention, subscribed skip/reply, assistant lifecycle                        | `slack-runtime.ts`, `bot-handlers.test.ts`, `new-mention-behavior.test.ts`, Slack assistant event docs         | Keep routing policy overlap linked to `agent-turn-handling`. |
| Slack thread context sourcing       | Seed once, persisted context, live assistant IDs                               | `thread-context.ts`, `turn-preparation`, Slack Assistant context-store guidance                                | Avoid over-specifying Slack history fetches.                 |
| Assistant-thread lifecycle delivery | started, context changed, title generation                                     | `assistant-thread/lifecycle.ts`, `assistant-lifecycle*.test.ts`                                                | Needs title-source verification map entry.                   |
| In-flight Slack progress            | start, update, fail, clear, compaction                                         | `assistant-thread/status*.ts`, `assistant-status-auth-contract.test.ts`, Slack `setStatus` docs                | Exact timing open.                                           |
| Automatic processing reaction       | explicit mention, subscribed approval, failure, keep explicit eyes             | `processing-reaction.ts`, `processing-reaction-behavior.test.ts`                                               | Reaction outbound idempotence belongs to outbound spec.      |
| Finalized Slack replies             | ignore deltas, final delivery, delivery failure, footer                        | `reply-executor.ts`, `slack/reply.ts`, `finalized-reply-behavior.test.ts`                                      | State commit after delivery is critical.                     |
| Continuation formatting             | split, markers, interrupted, code fences                                       | `slack/output.ts`, `finalized-reply-behavior.test.ts`, `oauth-resume-slack.test.ts`                            | Unit coverage may supplement integration.                    |
| File delivery                       | text+files, file-only, suppressed text, resume files                           | `slack/reply.ts`, `file-delivery-behavior.test.ts`, `oauth-resume-slack.test.ts`, Slack file docs              | Use product semantics, not legacy API names.                 |
| Image ingress preservation          | normalization, rehydration, skipped passive, vision unavailable                | `vision-context.ts`, attachment/image tests                                                                    | Cross-link future attachment-and-vision spec.                |
| Slack resume delivery               | timeout notice, duplicate continuation, auth pause, stale auth, final delivery | `slack-resume.ts`, `oauth-resume-slack.test.ts`, `turn-resume-slack.test.ts`, `mcp-auth-runtime-slack.test.ts` | Session mechanics belong to resumability spec.               |
| Verification taxonomy               | behavior vs transport vs eval                                                  | `specs/testing.md`, current test layout                                                                        | Follow-up tasks should rename/split later.                   |

## Migration Notes

- Canonical spec updates:
  - Keep `specs/slack-agent-delivery.md` authoritative until OpenSpec baseline is accepted.
  - Consider replacing legacy file API wording with transport-neutral file delivery semantics.
  - Add cross-links from final reply/footer sections to `slack-outbound-contract` where request shape is owned elsewhere.
- Index/pointer updates:
  - No index update needed for this draft because `specs/slack-agent-delivery.md` is already listed.
  - After archive, ensure `openspec/specs/slack-agent-delivery/spec.md` is discoverable from backfill program notes.
- Superseded content:
  - None yet. Do not archive canonical prose during this spec-only draft.
- Test/eval taxonomy changes:
  - Defer all test/eval renames and splits until the spec is accepted.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-slack-agent-delivery' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: exact status timing, OAuth connected banner behavior, footer field permanence, and file-upload terminology cleanup.
