import * as z from "zod";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const outputSchema = juniorToolOutputSchema.extend({
  url: z.string().url(),
});

/** Create a tool that gives a running sandbox server a public preview URL. */
export function createCreatePreviewTool(
  createPreview: NonNullable<SandboxWorkspace["createPreview"]>,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    approvalMode: "approve",
    description:
      "Create a public HTTPS preview URL for a server running in the sandbox. Anyone with the URL can open it until the sandbox stops. The URL for a port stays the same while the sandbox runs. Use it after you build or change something that a person can open in a browser, such as a web page or app, so they can try it.",
    executionMode: "sequential",
    inputSchema: z
      .object({
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe(
            "Port that the server listens on. The server must listen on 0.0.0.0.",
          ),
      })
      .strict(),
    outputSchema,
    async execute({ port }) {
      return { url: await createPreview(port) };
    },
  });
}
