# Endpoint and Fixture Matrix

Use this matrix to choose queue helpers, fixtures, and assertions.

| Module under test | Slack endpoints to queue | Fixture builders | Assertion helpers |
| --- | --- | --- | --- |
| `src/chat/slack-actions/channel.ts` | `chat.postMessage`, `chat.getPermalink`, `conversations.history`, `conversations.members`, `conversations.replies` | `chatPostMessageOk`, `chatGetPermalinkOk`, `conversationsHistoryPage`, `conversationsMembersPage`, `conversationsRepliesPage` | `getCapturedSlackApiCalls(method)` |
| `src/chat/slack-actions/canvases.ts` | `canvases.create`, `conversations.canvases.create`, `canvases.sections.lookup`, `canvases.edit`, `files.info` | `canvasesCreateOk`, `conversationsCanvasesCreateOk`, `canvasesSectionsLookupOk`, `canvasesEditOk`, `filesInfoOk` | `getCapturedSlackApiCalls(method)` |
| `src/chat/slack-actions/lists.ts` | `slackLists.create`, `slackLists.items.create`, `slackLists.items.list`, `slackLists.items.update`, `files.info` | `slackListsCreateOk`, `slackListsItemsCreateOk`, `slackListsItemsListPage`, `slackListsItemsUpdateOk`, `filesInfoOk` | `getCapturedSlackApiCalls(method)` |
| `src/chat/slack-actions/client.ts` (upload path) | `files.getUploadURLExternal`, `files.completeUploadExternal`, `files.slack.com/upload/*` | `filesGetUploadUrlOk`, `filesCompleteUploadOk` | `getCapturedSlackApiCalls(method)`, `getCapturedSlackFileUploadCalls()` |
| `src/chat/slack-user.ts` | `GET /api/users.info` | `usersInfoOk` | `getCapturedSlackApiCalls("users.info")` |

## Generic response helpers

- `slackOk(payload)`
- `slackError({ error, needed?, provided?, ... })`

Prefer endpoint fixtures when they exist. Use generic helpers only when the endpoint shape is not yet modeled.

## Sequencing rules

- Queue one response per expected outbound call in execution order.
- For pagination, queue multiple responses for the same endpoint with `next_cursor` behavior.
- For retries, queue rate-limit or error responses first, then success.

## Rate limit and error helpers

- `queueSlackApiError(method, input)` for Slack API envelopes with `ok: false`.
- `queueSlackRateLimit(method, retryAfterSeconds, body)` for HTTP 429 behavior.

## Determinism

Prefer factory defaults for stable assertions:

- IDs and timestamps from `tests/fixtures/slack/factories/ids.ts`
- Structured payload factories from `tests/fixtures/slack/factories/api.ts`
