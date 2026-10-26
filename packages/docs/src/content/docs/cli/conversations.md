---
title: "junior conversations"
description: "List your active Conversations with dashboard and Slack links."
type: reference
summary: Print one JSON line for each of your active Conversations.
prerequisites:
  - /operate/dashboard/
related:
  - /cli/briefs/
  - /concepts/conversations/
---

Use `junior conversations list` to build an index of your Conversations. Each line links back to the dashboard and, when the Conversation started in Slack, to the Slack thread.

## Usage

Create a personal API token in the Junior dashboard. Then list your Conversations:

```bash
pnpm exec junior conversations list \
  --base-url https://junior.example.com \
  --token "$JUNIOR_API_TOKEN"
```

You can omit `--token` when `JUNIOR_API_TOKEN` is set. Use the full base URL with `https://`.

## What it does

The command reads `GET /api/conversations` and follows `nextCursor` until no pages remain. It prints one JSON object per line:

```json
{
  "id": "slack:C123:1700000000.000100",
  "title": "Deploy question",
  "url": "https://junior.example.com/conversations/slack%3AC123%3A1700000000.000100",
  "slackUrl": "https://example.slack.com/archives/C123/p1700000000000100"
}
```

The list has the active root Conversations that you started or joined. It does not include archived Conversations or child agent Conversations. `slackUrl` is `null` when the Conversation has no Slack thread. The output can contain titles of private Conversations, so keep the file private.

A Conversation that gets new activity while the command runs moves to the top of the list. The command does not show it again on a later page.

## Failure behavior

A missing or expired token fails with a `401` response:

```text
Dashboard request failed (401 Unauthorized): {"error":"unauthenticated"}
```

Create a new token in the dashboard and run the command again. A base URL without `https://` can fail with a redirect error. Add the scheme to `--base-url`.

## Verification

1. Run the command and save the output: `pnpm exec junior conversations list --base-url <url> > conversations.jsonl`.
2. Count the lines with `wc -l conversations.jsonl`. The number must match the active Conversations in the dashboard.
3. Open one `url` and one `slackUrl` to confirm that the links work.

## Next step

Pass the `id` values to [`junior briefs pull`](/cli/briefs/) to download snapshots of those Conversations.
