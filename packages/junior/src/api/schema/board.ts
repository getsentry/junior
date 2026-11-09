import * as z from "zod";
import { actorIdentitySchema } from "./conversation";

export const boardColumnSchema = z.enum([
  "planned",
  "in_progress",
  "ready",
  "done",
]);

export const boardCardSchema = z
  .object({
    /** Stable card id. One object gives one card. */
    key: z.string().min(1),
    column: boardColumnSchema,
    objectType: z.enum(["task", "code_change"]),
    title: z.string().min(1),
    /** Short object reference, such as `getsentry/junior#42`. */
    label: z.string().min(1),
    url: z.string().url().optional(),
    status: z.string().min(1),
    /** When the card last changed. A Done card uses its finish time. */
    updatedAt: z.string(),
    conversation: z
      .object({
        conversationId: z.string().min(1),
        title: z.string().optional(),
        /** Root title when the card comes from a Thread. */
        rootTitle: z.string().optional(),
      })
      .strict(),
    participants: z.array(actorIdentitySchema),
    /** A Turn runs in the Conversation of the card or in one of its Tasks. */
    working: z.boolean(),
    /** The Conversation has an open review item that needs the viewer. */
    needsViewer: z.boolean(),
  })
  .strict();

export const boardReportSchema = z
  .object({
    cards: z.array(boardCardSchema),
    doneWindowHours: z.number().int().positive(),
  })
  .strict();

export type BoardColumn = z.output<typeof boardColumnSchema>;
export type BoardCard = z.output<typeof boardCardSchema>;
export type BoardReport = z.output<typeof boardReportSchema>;
