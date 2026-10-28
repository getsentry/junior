import { z } from "zod";

const taskMessageDestinationInputSchema = z
  .enum(["current_conversation", "task_creator"])
  .describe(
    "Where to send the message. Use current_conversation for posts, digests, summaries, and channel reminders. Use task_creator only when the user asks for a direct reminder or notification.",
  );

/** Input accepted by task authoring tools before a user becomes a DM Destination. */
export const taskOutcomeInputSchema = z
  .object({
    action: z.literal("send_message"),
    destination: taskMessageDestinationInputSchema,
  })
  .strict();

export type TaskOutcomeInput = z.output<typeof taskOutcomeInputSchema>;
