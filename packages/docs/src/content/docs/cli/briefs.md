---
title: "junior briefs"
description: "Download Conversation snapshots and generate local Briefs."
type: reference
summary: Pull a complete Conversation report and replay Brief generation locally.
prerequisites:
  - /reference/config-and-env/
related:
  - /cli/chat/
  - /concepts/conversations/
---

Use `junior briefs` to inspect and tune Brief generation without changing production data. A Brief records the intent, outcome, decisions, open decisions, durable facts, and evidence links for one Conversation.

## Pull snapshots

Create a personal API token in the Junior dashboard. Then download one or more Conversations:

```bash
pnpm exec junior briefs pull <conversation-id> \
  --base-url https://junior.example.com \
  --token "$JUNIOR_API_TOKEN" \
  --out ./brief-snapshots
```

You can omit `--token` when `JUNIOR_API_TOKEN` is set. The command downloads the detail report and follows all older event pages. The saved JSON does not contain the API token.

You can pull any public Conversation. You can pull a private Conversation only when your token can view its content. Expired and redacted transcripts cannot generate a Brief.

## Generate Briefs

Run the default prompt and the app's configured fast model against a snapshot:

```bash
pnpm exec junior briefs run ./brief-snapshots/<conversation-id>.snapshot.json \
  --out ./brief-output
```

The command writes `<conversation-id>.brief.json` and `<conversation-id>.brief.md`. The Markdown file ends with an evidence check. It shows link counts, dropped model URLs, and model cost.

Without `--model`, the command resolves the current `AI_FAST_MODEL` configuration when the run starts. Use `--model <id>` or `--prompt <file>` to compare generation settings. Add `--turn-by-turn` to generate one version for each completed turn in the snapshot.

Brief generation needs Vercel OIDC or `AI_GATEWAY_API_KEY`. Snapshot download needs only the dashboard token.
