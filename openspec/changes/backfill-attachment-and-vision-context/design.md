# Design: `attachment-and-vision-context`

## Scope

`attachment-and-vision-context` owns how inbound Slack attachments become safe, bounded, model-usable context. It starts when Slack/Chat SDK messages expose attachments or file metadata and ends when the runtime hands `userAttachments`, conversation context, and omitted-image counts to the agent.

It does not own outbound reply file uploads, generated file attachment tools, final reply post planning, or conversational quality.

## Prior Art Constraints

Slack message events may include file arrays with private file URLs, and the legacy `file_share` subtype example shows file data under the message `files` array. Slack also documents that some Slack Connect file payloads may initially contain `file_access: "check_file_info"` rather than full metadata, requiring a later `files.info` lookup. Junior's spec should therefore require preserving recoverable file identifiers and URLs when present, but it should not assume every inbound file event has immediately downloadable metadata.

Slack image blocks require alt text for outbound presentation, but inbound image understanding is a bot/runtime concern. Junior currently uses a vision model to convert image bytes into concise text summaries rather than putting raw image bytes into long-lived conversation memory.

## Design Decisions

### Persist attachment facts, not private URLs

Conversation state should remember that a user message had attachments/images and which image file IDs were summarized. It should not preserve private Slack URLs, OAuth tokens, or raw file bytes in durable model context.

### Summarize images once and cache by Slack file ID

Thread image hydration should summarize each Slack image file once when possible and reuse the cached summary for later turns or current-message attachment context. This prevents repeat downloads/model calls and lets later explicit mentions refer to earlier skipped screenshots.

### Treat unavailable vision as known missing capability

When vision is disabled, image attachments should not be fetched or silently ignored. Runtime context should tell the agent that images were attached but omitted so the reply can say it received an image but cannot inspect it.

### Keep non-image files bounded

Non-image attachments can be passed to the agent as bounded data when available. Oversized or failed non-image downloads are skipped without failing the whole turn. Required image analysis failures are stricter because the user often asks about the image itself.

### Keep queue/deserialization paths equivalent

Queued or serialized messages lose function-valued fetchers. The queue boundary must rehydrate private-file fetchers from stored URLs before runtime attachment resolution.

## Risks

- Current hydration depends on Slack thread-reply lookup for some prior images; Slack Connect `check_file_info` handling may be incomplete.
- The exact image/file count limits are implementation details, but changing them can affect model context and cost.
- Vision failures for current-message images are handled more strictly than non-image file failures; this distinction should remain explicit.

## Open Questions

1. Should Slack Connect `file_access: "check_file_info"` be a required current behavior or a follow-up capability gap?
2. Should the maximum number of attachments and bytes be specified as exact product limits or implementation-tunable bounds?
3. Should current-message image failures always abort the agent turn, or only when the user’s text appears image-dependent?
4. Should legacy Slack attachment rendering stay in this capability or move to `slack-ingress-routing` after canonicalization?
