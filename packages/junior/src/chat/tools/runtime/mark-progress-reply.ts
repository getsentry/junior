import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

/** Create the tool that marks the replies of a Turn as progress only. */
export function createMarkProgressReplyTool() {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Mark the replies that you write after this call in the Turn as progress only. They are still posted, but the conversation does not become unread and nobody gets a push notification. A reply with a card still notifies.",
    exposure: "modelOnly",
    inputSchema: z.object({}).strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async () => ({}),
  });
}
