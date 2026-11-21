import * as z from "zod";

/** Model-facing id of one attachment in the current Conversation. */
export const attachmentIdParam = z
  .string()
  .min(1)
  .describe(
    "Stored attachment ID, as shown in attachment context or Slack read results.",
  );
