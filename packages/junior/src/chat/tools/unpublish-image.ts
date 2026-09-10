import { z } from "zod";
import { unpublishArtifact } from "@/chat/artifacts/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { JuniorSqlDatabase } from "@/db/db";

const outputSchema = juniorToolOutputSchema.extend({
  filename: z.string().min(1),
  unpublished: z.literal(true),
});

/** Create a tool that stops serving one previously published public image. */
export function createUnpublishImageTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
}) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    approvalMode: "review",
    description:
      "Unpublish one public image previously published in this conversation so its public URL stops serving. Pass the public artifact URL or `<id>.<ext>` filename. Only images owned by this conversation can be unpublished. Republishing the same image bytes later in this conversation restores a live URL for this conversation. Does not remove copies already fetched by browsers or GitHub.",
    describeProposal: ({ ref }) => `Unpublish public image ${ref}.`,
    executionMode: "sequential",
    inputSchema: z
      .object({
        ref: z
          .string()
          .min(1)
          .describe(
            "Public artifact URL or artifact filename (`<id>.<ext>`).",
          ),
      })
      .strict(),
    outputSchema,
    async execute({ ref }) {
      const result = await unpublishArtifact({
        conversationId: args.conversationId,
        db: args.db,
        ref,
      });
      return {
        filename: result.filename,
        unpublished: true as const,
      };
    },
  });
}
