import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

export const noReplyToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  description:
    "End the Turn without a reply. Nothing is posted and nobody is notified.",
  exposure: "modelOnly",
  inputSchema: z
    .object({
      note: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .optional()
        .describe(
          "Outcome to keep in the conversation without notifying anyone, such as a routine fix that worked. Omit it when a person asked for no reply. Null is the same as omitted.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    note: z.string().optional(),
  }),
});

/** Create the tool that ends a Turn with no reply. */
export function createNoReplyTool() {
  return zodTool({
    ...noReplyToolDefinition,
    execute: async (input) => (input.note ? { note: input.note } : {}),
  });
}
