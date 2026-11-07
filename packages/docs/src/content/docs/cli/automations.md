---
title: "junior automations"
description: "List the Automations that you created as JSON lines."
type: reference
summary: Print one JSON line for each Automation that you created.
prerequisites:
  - /operate/dashboard/
related:
  - /cli/conversations/
  - /operate/mcp-server/
---

Use `junior automations list` to export or sync your Automations. Each line has the same fields as an Automation from the MCP `searchAutomations` tool.

## Usage

Create a personal API token in the Junior dashboard. Then list your Automations:

```bash
pnpm exec junior automations list \
  --base-url https://junior.example.com \
  --token "$JUNIOR_API_TOKEN"
```

You can omit `--token` when `JUNIOR_API_TOKEN` is set. `--base-url` is the host that serves the API, with `https://`. Do not add the dashboard base path.

## What it does

The command reads `GET /api/automations` with `scope=mine` and `sort=oldest`, 100 Automations per page, until it reaches `total`. It prints one JSON object per line:

```json
{
  "id": "sched_weekly_digest",
  "kind": "scheduled",
  "title": "Weekly digest",
  "instruction": "Post the weekly issue digest.",
  "status": "active",
  "trigger": "Every Monday at 09:00 (Europe/Vienna)",
  "nextRunAt": "2026-11-09T08:00:00.000Z",
  "destination": "#team-digest",
  "createdBy": "Johannes",
  "ownedByYou": true,
  "lastRunAt": "2026-11-02T08:00:00.000Z",
  "lastRunStatus": "completed",
  "lastConversationId": "slack:C123:1730534400.000100",
  "url": "https://junior.example.com/automations/sched_weekly_digest"
}
```

The list has every scheduled and event Automation that you created, in all states. It does not include Automations that other people created. `url` is the dashboard link that the server builds. It is missing when the dashboard is turned off. `lastConversationId` names the Conversation of the last run. The output can contain instructions of private Automations, so keep the file private.

An Automation that you create while the command runs comes last. An Automation that you delete while the command runs can move another Automation to an earlier page, so the command can miss it. Run the command again to get a full list.

## Failure behavior

A missing or expired token fails with a `401` response:

```text
Dashboard request failed (401 Unauthorized): {"error":"unauthenticated"}
```

Create a new token in the dashboard and run the command again.

## Verification

1. Run the command and save the output: `pnpm exec junior automations list --base-url <url> > automations.jsonl`.
2. Count the lines with `wc -l automations.jsonl`. The number must match the **Mine** count on the dashboard Automations page.
3. Open one `url` to confirm that the link works.
