import { z } from "zod";

/** Model-facing Slack list ID parameter. */
export const slackListIdParam = z.string().min(1).describe("Slack list ID.");

/** Model-facing Slack list item ID parameter. */
export const slackListItemIdParam = z
  .string()
  .min(1)
  .describe("Slack list item ID.");
