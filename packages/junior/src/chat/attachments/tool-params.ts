import * as z from "zod";

/** Model-facing id of one attachment that the current Conversation can read. */
export const attachmentIdParam = z
  .string()
  .min(1)
  .describe(
    "Stored attachment ID, as shown in attachment context, Slack read results, or the task or events of a Conversation that this one can read, such as its parent.",
  );
