/**
 * Runtime registration for asynchronous completed-turn analytics.
 * Classification and cleanup stay behind plugin task and heartbeat boundaries.
 */
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { classifyTurn } from "./classify";
import {
  deleteExpiredConversationClassifications,
  type ConversationClassificationDb,
} from "./store";
import {
  conversationClassificationOptionsSchema,
  DEFAULT_TURN_INTENT_TAXONOMY,
  type ConversationClassificationOptions,
} from "./types";

const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000;
const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Create asynchronous per-turn conversation classification. */
export function createConversationClassificationPlugin(
  options: ConversationClassificationOptions = {},
) {
  const parsed = conversationClassificationOptionsSchema.parse(options);
  const taxonomy = parsed.taxonomy ?? DEFAULT_TURN_INTENT_TAXONOMY;
  const classificationConfig = {
    maxTranscriptChars:
      parsed.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
    retentionMs: (parsed.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS,
    taxonomy,
  };
  return defineJuniorPlugin({
    manifest: {
      name: "conversation-classification",
      displayName: "Conversation Classification",
      description:
        "Asynchronously classifies completed conversation turns for product analytics",
    },
    model: parsed.modelId
      ? { structuredModelId: parsed.modelId }
      : { structuredModel: "fast" },
    packageName: "@sentry/junior-conversation-classification",
    tasks: {
      classifyTurn: {
        async run(ctx) {
          await classifyTurn(ctx, classificationConfig);
        },
      },
    },
    hooks: {
      async heartbeat(ctx) {
        await deleteExpiredConversationClassifications(
          ctx.db as ConversationClassificationDb,
          ctx.nowMs,
        );
      },
    },
  });
}
