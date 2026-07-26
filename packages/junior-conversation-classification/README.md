# @sentry/junior-conversation-classification

Classifies the primary job requested in each completed Junior turn.
Classification runs after visible reply delivery, so model or storage failures
do not change the user-facing response.

## Install and register

```bash
pnpm add @sentry/junior-conversation-classification
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { createConversationClassificationPlugin } from "@sentry/junior-conversation-classification";

export const plugins = defineJuniorPlugins([
  createConversationClassificationPlugin(),
]);
```

Apply the packaged SQL migration before serving traffic:

```bash
pnpm exec junior upgrade
```

## Default taxonomy

The default `turn-intent-v1` taxonomy reflects common Junior jobs:
`product_question`, `customer_support`, `code_change`, `bug_investigation`,
`incident_response`, `security_review`, `product_analysis`,
`operational_analysis`, `knowledge_lookup`, `market_account_research`,
`project_management`, `planning_design`, `decision_support`,
`writing_communication`, `workflow_automation`, and `other`.

## Configuration

```ts
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
- `retentionDays` defaults to `90`; heartbeat cleanup removes expired rows.
- Category ids must be unique lowercase identifiers. Keep ids stable within a
  taxonomy version and change the version when definitions materially change.

## Data handling

The plugin sends a bounded second model request containing only:

- instruction-authority user messages from the completed turn;
- tool names and success/error status, never tool-result bodies.

Common credential formats are redacted before model processing. Ambient public
thread context is excluded. The plugin stores only the category, confidence,
taxonomy and model metadata, timestamps, expiry, and conversation id; it does
not persist transcript text.

## Reporting

The plugin writes one idempotent row per completed turn. Reporting can select
the earliest row per `conversation_id` for initial-intent analytics, or analyze
all rows to measure how requests change across a conversation.
