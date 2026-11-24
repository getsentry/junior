/**
 * The result of `startAgent`. A Lead's start also offers a Watch of the
 * root, and the dashboard reads it to link the root.
 */
import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { SHORT_TITLE_MAX_LENGTH } from "@/chat/services/short-title";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";

/** Title of an agent that `startAgent` starts. */
export const startedAgentTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(SHORT_TITLE_MAX_LENGTH);

/** The result of `startAgent` for a child agent. */
export const startedAgentSchema = juniorToolOutputSchema.extend({
  conversation_id: z
    .string()
    .min(1)
    .describe(
      "Conversation ID of the new agent. Pass it to messageAgent, stopAgent, or archiveAgent.",
    ),
  url: z
    .string()
    .url()
    .optional()
    .describe("Link to the conversation. People can message it there."),
});

/** The result of `startAgent` for a root that a Lead started. */
export const leadStartedAgentSchema = startedAgentSchema.extend({
  subscribable: subscribableResourceSchema.describe(
    "Watch it with watchEvents only when the person asks to hear back.",
  ),
});
