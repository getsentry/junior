import * as z from "zod";

/** Where a Conversation sits in its tree. See `TERMINOLOGY.md`. */
export const conversationKindSchema = z.enum([
  "root",
  "automation",
  "lead",
  "thread",
  "task",
]);
