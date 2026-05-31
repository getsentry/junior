# Backfill Worksheet: `attachment-and-vision-context`

## Scope

- Capability: Attachment and vision context
- Change: `backfill-attachment-and-vision-context`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/attachment-and-vision-context/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/slack-agent-delivery.md`: currently includes image ingress expectations and file delivery notes.
- `specs/slack-outbound-contract.md`: owns outbound file upload behavior and Slack API write boundaries.
- `specs/conversation-state.md`: owns persisted conversation messages and vision cache shape.
- `specs/queue-and-locking.md`: owns queued/skipped message preservation and fetcher rehydration boundary.
- `specs/agent-turn-handling.md`: owns how the agent should answer when attachment context is present or missing.
- `specs/reply-planning.md`: owns final reply file visibility and attachment-claim correction.
- `specs/testing.md`: owns unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/services/vision-context.ts`: current-turn attachment resolution, image summarization, vision cache lookup, thread image hydration, size bounds, and omitted/failure behavior.
- `packages/junior/src/chat/runtime/turn-preparation.ts`: conversation message persistence, attachment/image counts, `imagesHydrated`, legacy attachment text, and hydration trigger logic.
- `packages/junior/src/chat/runtime/turn-user-message.ts`: resumed-turn reconstruction of attachment counts and omitted-image counts.
- `packages/junior/src/chat/runtime/reply-executor.ts`: resolves user attachments and passes `userAttachments`, inbound counts, and omitted image counts to the agent.
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`: rehydrates private-file fetchers for deserialized queued messages.
- `packages/junior/src/chat/ingress/message-changed.ts`: extracts attachments from edited Slack message files.
- `packages/junior/src/chat/slack/legacy-attachments.ts`: renders legacy Slack attachment fields into bounded text.
- `packages/junior/src/chat/respond.ts`: projects attachment prompt text, image content, text previews, and omitted-image notices into model input.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/slack/legacy-attachments.test.ts`
  - `packages/junior/tests/unit/misc/attachment-claims.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/attachment-behavior.test.ts`
  - `packages/junior/tests/integration/slack/attachment-media-behavior.test.ts`
  - `packages/junior/tests/integration/slack/bot-image-hydration.test.ts`
  - `packages/junior/tests/integration/slack/message-im-attachment-contract.test.ts`
  - `packages/junior/tests/integration/slack/file-delivery-behavior.test.ts`
  - `packages/junior/tests/integration/slack-file-upload.test.ts`
- Evals:
  - Attachment answer quality and omitted-image wording belong to broader agent behavior evals, not this deterministic context capability.

## Prior Art

- Slack Events API message events can carry file arrays, and Slack documents file-bearing message/file-share payloads with private file URLs.
- Slack documents that Slack Connect file metadata may be incomplete at event time and may require a later `files.info` lookup.
- Slack image presentation requires accessible alt text for outbound image blocks; Junior's inbound image path analogously converts images into concise text summaries before adding them to long-lived context.
- Modern chatbot runtimes commonly keep raw binary/private platform data out of durable conversation memory and project bounded summaries into the model turn.

Sources:

- Slack file-share message event docs: https://docs.slack.dev/reference/events/message/file_share
- Slack file-shared event docs: https://docs.slack.dev/reference/events/file_shared
- Slack Events API docs: https://docs.slack.dev/apis/events-api/
- Slack image block docs: https://docs.slack.dev/reference/block-kit/blocks/image-block

## Implemented Behavior

- Behavior that code currently enforces:
  - Slack ingress and message edit paths preserve file/image attachment metadata where available.
  - Queued/deserialized attachments can regain `fetchData` from private URLs.
  - Conversation messages store attachment count, image count, Slack timestamp, and `imagesHydrated`; they do not store raw bytes.
  - Legacy Slack attachments are rendered into bounded `[attachment]` text.
  - Current-turn image attachments are summarized when `AI_VISION_MODEL` is configured.
  - Image summaries are truncated to 500 characters.
  - At most three current user attachments and three image files per message are considered; per-file byte budget is 5 MiB.
  - Cached image summaries are reused by file ID and attachment position.
  - Non-image oversized or failed attachments are skipped while the turn continues.
  - Current image analysis failures fail before invoking the main agent and use fallback-error delivery.
  - When vision is disabled, image bytes are not fetched and omitted-image counts reach the agent context.
  - Thread image hydration can recover older skipped screenshots and include summaries in later conversation context.
  - Resumed-turn attachment context can be reconstructed from persisted message metadata.
- Behavior that tests currently verify:
  - Image attachment data is fetched and summarized before agent context.
  - Vision failure posts fallback and does not invoke the main agent.
  - Mixed media keeps valid attachments and skips oversized/failed non-image attachments.
  - Vision-disabled images are dropped from `userAttachments` but counted as omitted.
  - Only-image messages still run the assistant with omitted-image context when vision is disabled.
  - DM `message.im` file-share image attachments survive webhook/adapter path.
  - Vision hydration runs once with shared state, backfills after vision is enabled later, hydrates skipped passive screenshots, reuses cached summaries, preserves attachment-position alignment, and truncates summaries.
  - Legacy attachment rendering is bounded and drops noisy/interactive fields.
- Behavior that appears accidental or weakly enforced:
  - Slack Connect `file_access: "check_file_info"` is recognized as prior-art risk but current implementation coverage is unclear.
  - Resumed-turn attachment-context reconstruction may need focused unit coverage.
  - Exact limits are code constants, not clearly product-decided values.
  - Current-image vision failure always aborts, even if a user request might be answerable without the image.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Preserve attachment facts across ingress, queueing, persistence, and resume.
  - Convert images to bounded summaries when vision is enabled.
  - Reuse cached vision summaries and avoid raw private data in durable state.
  - Tell the model when images were present but unavailable.
  - Keep non-image attachment failures non-fatal unless a stricter product rule is introduced.
  - Recover prior skipped screenshots for later explicit mentions when possible.
- Behavior that should remain implementation detail:
  - Exact byte/count limits unless product fixes them.
  - Exact vision prompt wording.
  - Exact cache timestamp fields.
  - Exact Slack HTTP endpoint calls used to download private files.
- Behavior that should be non-goal:
  - Outbound generated-file upload.
  - Slack file upload API retry/error mapping.
  - Model answer quality for image summaries.
  - General OCR/image understanding beyond concise factual summaries.

## Undefined Behavior / Open Questions

| Question                                                      | Evidence                                                                                         | Options                                                                | Recommendation                                                            | Status |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| Do we fully support Slack Connect `check_file_info` payloads? | Slack docs say metadata may be incomplete; inspected code mainly uses file URLs already present. | Required current behavior, follow-up gap, or non-goal.                 | Mark as explicit gap until verified.                                      | open   |
| Are attachment limits normative?                              | Constants are three attachments, three images, 5 MiB, 500 summary chars.                         | Exact product limits, tunable bounds, or implementation detail.        | Specify bounded behavior; record current values as implementation notes.  | open   |
| Should current image failures always abort?                   | `vision-context.ts` throws for image failures; tests expect fallback and no agent call.          | Always abort, intent-sensitive abort, or continue with omitted notice. | Keep current behavior but review product tradeoff.                        | open   |
| Where should legacy attachment rendering live?                | It runs in turn preparation but is Slack-ingress-shaped.                                         | This capability, ingress routing, or conversation state.               | Keep here because it becomes model context.                               | open   |
| Should attachment claim truth be here or reply planning?      | Current backfill also references misleading attachment claims.                                   | Reply planning, attachment context, or split.                          | Split: truth correction in reply planning; inbound attachment facts here. | open   |

## OpenSpec Requirements Draft

| Requirement                          | Scenarios                                                                  | Source Evidence                                    | Notes                               |
| ------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| Inbound attachment normalization     | message files, edited files, queued fetcher, persisted metadata            | ingress, dispatcher, turn preparation              | No private data in durable state.   |
| Legacy Slack attachment text context | fallback-only, rich fields, truncation                                     | `legacy-attachments.ts`, unit tests                | Model context, not outbound blocks. |
| Current-turn attachment resolution   | image vision, cached summary, non-image, skipped/failure                   | `vision-context.ts`, integration tests             | Strongest user-visible edge.        |
| Vision-disabled image handling       | unset model, only images, resumed turn                                     | `vision-context.ts`, `turn-user-message.ts`, tests | Avoid "no image attached" lie.      |
| Conversation image hydration         | unhydrated messages, cache hit, cache miss, missing/large, passive skipped | `vision-context.ts`, image hydration tests         | Enables later references.           |
| Slack file metadata incompleteness   | partial file payload, unavailable metadata                                 | Slack docs, code gap                               | Explicit undefined area.            |
| Attachment context prompt projection | summary text, text preview, binary bytes                                   | `respond.ts`                                       | Prompt shape without exact prose.   |
| Verification taxonomy                | unit, integration, eval boundary                                           | `testing.md`                                       | Keep model quality evals elsewhere. |

## Migration Notes

- Canonical spec updates:
  - Add `attachment-and-vision-context` to index after acceptance.
  - Narrow image-ingress material in `slack-agent-delivery` to a pointer.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Move detailed inbound image context rules out of broad Slack delivery prose when this capability is accepted.
- Test/eval taxonomy changes:
  - Rename broad attachment behavior tests only if discoverability improves.
  - Keep answer-quality evals with agent behavior capabilities.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-attachment-and-vision-context' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: Slack Connect partial file metadata, resumed attachment-context reconstruction, exact limits policy, and intent-sensitive image failure behavior.
