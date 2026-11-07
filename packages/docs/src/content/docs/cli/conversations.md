---
title: "junior conversations"
description: "List your Conversations and their Threads as JSON lines."
type: reference
summary: Print one JSON line for each of your Conversations and their Threads.
prerequisites:
  - /operate/dashboard/
related:
  - /cli/briefs/
  - /concepts/conversations/
---

Use `junior conversations list` to export or sync an index of your Conversations. Each line has the same fields as a Conversation from the MCP `searchConversations` tool.

## Usage

Create a personal API token in the Junior dashboard. Then list your Conversations:

```bash
pnpm exec junior conversations list \
  --base-url https://junior.example.com \
  --token "$JUNIOR_API_TOKEN"
```

Add `--status archived` to list the Conversations that you archived. The default is `--status active`. You can omit `--token` when `JUNIOR_API_TOKEN` is set. `--base-url` is the host that serves the API, with `https://`. Do not add the dashboard base path.

## What it does

The command reads `GET /api/conversations` and follows `nextCursor` until no pages remain. It prints one JSON object per line. A root Conversation comes first, then each of its visible Threads:

```json
{"conversationId":"slack:C123:1700000000.000100","title":"Deploy question","kind":"root","status":"completed","surface":"slack","channelName":"deploys","locationUrl":"https://example.slack.com/archives/C123/p1700000000000100","startedAt":"2026-11-01T09:00:00.000Z","lastSeenAt":"2026-11-01T09:30:00.000Z","url":"https://junior.example.com/conversations/slack%3AC123%3A1700000000.000100"}
{"conversationId":"agent:7f3c","title":"Check the rollout","kind":"thread","parentConversationId":"slack:C123:1700000000.000100","status":"completed","surface":"internal","startedAt":"2026-11-01T09:10:00.000Z","lastSeenAt":"2026-11-01T09:20:00.000Z","url":"https://junior.example.com/conversations/agent%3A7f3c"}
```

The list has the root Conversations that you started or joined, and their Threads. It does not include Tasks. The server builds both links:

- `url` is the dashboard link. It includes the dashboard base path. It is missing when the dashboard is turned off.
- `locationUrl` is the outside location, such as a Slack thread. It is missing when the Conversation has no outside location, for example when it started in the dashboard.
- `parentConversationId` is set on a Thread. It can name a Task that the list does not print.

The output can contain titles of private Conversations, so keep the file private.

A Conversation that gets new activity while the command runs moves to the top of the list. The command does not show it again on a later page. The list does not show archived Threads, or any Thread under a root that you archived.

## Failure behavior

A missing or expired token fails with a `401` response:

```text
Dashboard request failed (401 Unauthorized): {"error":"unauthenticated"}
```

Create a new token in the dashboard and run the command again. A base URL without `https://` can fail with a redirect error. Add the scheme to `--base-url`.

## Verification

1. Run the command and save the output: `pnpm exec junior conversations list --base-url <url> > conversations.jsonl`.
2. Count the root lines with `grep -c '"kind":"root"' conversations.jsonl`. The number must match the active Conversations in the dashboard.
3. Open one `url` and one `locationUrl` to confirm that the links work.

## Next step

Pass the `conversationId` values to [`junior briefs pull`](/cli/briefs/) to download snapshots of those Conversations.
