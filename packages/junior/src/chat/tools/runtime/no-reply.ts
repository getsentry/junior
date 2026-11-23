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
  description: "End the Turn quietly, without a reply.",
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
          "Outcome to keep in the conversation, such as a routine fix that worked. It is not posted as a reply. A parent agent or a watcher of this conversation can get it. Omit it when a person asked for no reply. Null is the same as omitted.",
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
