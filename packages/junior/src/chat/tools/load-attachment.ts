import path from "node:path";
import { z } from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import { readLiveAttachment } from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const ATTACHMENT_DIR = ".junior/attachments";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Create a tool that restores one stored conversation attachment to the sandbox. */
export function createLoadAttachmentTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage: AttachmentStorage;
  workspace: SandboxWorkspace;
}) {
  return zodTool({
    description:
      "Load a stored attachment for this conversation into the sandbox. Use the attachment_id shown in attachment context or Slack read results.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z.object({
      attachment_id: z.string().min(1).describe("Stored attachment ID."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ attachment_id }) => {
      const attachment = await readLiveAttachment({
        attachmentId: attachment_id,
        conversationId: args.conversationId,
        db: args.db,
      });
      if (!attachment || attachment.storageProvider !== args.storage.provider) {
        throw new ToolInputError("Attachment not found in this conversation.");
      }
      const body = await args.storage.get(attachment.storageKey);
      if (!body) {
        throw new ToolInputError("Stored attachment contents are unavailable.");
      }
      const sandboxPath = path.posix.join(
        ATTACHMENT_DIR,
        attachment.id,
        path.posix.basename(attachment.filename),
      );
      await args.workspace.writeFiles([
        { content: await readStream(body), path: sandboxPath },
      ]);
      return {
        path: sandboxPath,
        filename: attachment.filename,
        mime_type: attachment.contentType,
        bytes: attachment.bytes,
      };
    },
  });
}
