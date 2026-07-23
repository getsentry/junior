---
title: Conversation Classification Plugin
description: Classify the primary job requested in Junior conversations for aggregate product analytics.
type: tutorial
summary: Configure asynchronous per-turn classification with a stable taxonomy and bounded retention.
prerequisites:
  - /extend/
related:
  - /concepts/skills-and-plugins/
  - /operate/security-hardening/
  - /reference/runtime-commands/
---

The conversation classification plugin records one requested-job category for
each successfully completed turn. Classification runs after visible reply
delivery and does not change the user-facing response.

## Install

```bash
pnpm add @sentry/junior-conversation-classification
```

## Register

Add the plugin factory to `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { createConversationClassificationPlugin } from "@sentry/junior-conversation-classification";

export const plugins = defineJuniorPlugins([
  createConversationClassificationPlugin(),
]);
```

The plugin uses runtime hooks and background tasks, so do not register it as a
bare package-name string.

## Run migrations

Apply the packaged Postgres migration before serving traffic:

```bash
pnpm exec junior upgrade
```

## Configure

```ts title="plugins.ts"
createConversationClassificationPlugin({
  maxTranscriptChars: 8_000,
  modelId: "anthropic/claude-haiku-4.5",
  retentionDays: 180,
  taxonomy: {
    version: "company-intent-v1",
    categories: [
      {
        id: "engineering",
        description: "Implementation, debugging, or code review work.",
      },
      {
        id: "research",
        description: "Investigation or information gathering without changes.",
      },
      {
        id: "other",
        description: "No other category is a confident fit.",
      },
    ],
  },
});
```

- `modelId` defaults to Junior's fast structured model.
- `maxTranscriptChars` defaults to `12000` and must be at least `256`.
- `retentionDays` defaults to `90` and controls plugin-owned cleanup.
- Category ids must be unique lowercase identifiers. Keep ids stable within a
  version and change the version when category definitions materially change.

## Data handling

The additional structured-model request contains only authoritative user
instructions from the completed turn and tool names with success/error status.
Ambient thread context, assistant text, and tool-result bodies are excluded.
The plugin stores no transcript text.

## Verify

Run a local conversation through the configured app:

```bash
pnpm cli -- chat -p "Explain what the conversation classification plugin measures."
```

Confirm the command exits successfully and that the background task writes a
row to `junior_conversation_classifications`.

For initial-intent reporting, select the earliest `turn_completed_at_ms` row
for each `conversation_id`. Keep all rows when analyzing how requests change
within longer conversations.

## Next step

Review [Security Hardening](/operate/security-hardening/) before enabling
classification for private workplace conversations.
