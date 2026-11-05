import path from "node:path";
import * as z from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  readLiveAttachment,
  readLiveAttachmentsForConversation,
  type AttachmentRecord,
} from "@/chat/attachments/store";
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
  // Tools are built per turn. Load the conversation's attachment metadata once
  // and share it across calls so a script loading N files issues one query.
  let liveAttachments: Promise<Map<string, AttachmentRecord>> | undefined;
  const findAttachment = async (
    attachmentId: string,
  ): Promise<AttachmentRecord | null> => {
    liveAttachments ??= readLiveAttachmentsForConversation({
      conversationId: args.conversationId,
      db: args.db,
    }).catch((error: unknown) => {
      liveAttachments = undefined;
      throw error;
    });
    const cached = (await liveAttachments).get(attachmentId);
    if (cached) return cached;
    // Attachments stored after the first load (e.g. mid-turn) miss the cache.
    return readLiveAttachment({
      attachmentId,
      conversationId: args.conversationId,
      db: args.db,
    });
  };
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
      const attachment = await findAttachment(attachment_id);
      if (!attachment || attachment.storageProvider !== args.storage.provider) {
        throw new ToolInputError("Attachment not found in this conversation.");
      }
      const body = await args.storage.get(attachment.storageKey);
      if (!body) {
        throw new ToolInputError("Stored attachment contents are unavailable.");
      }
      const data = await readStream(body);
      if (data.byteLength !== attachment.bytes) {
        // A storage read that returns fewer (or more) bytes than the durable
        // row expects is corrupt, not a valid empty/short file. Fail loudly
        // instead of silently writing truncated content to the sandbox.
        throw new Error(
          `Attachment ${attachment.id} read ${data.byteLength} bytes, expected ${attachment.bytes}.`,
        );
      }
      const attachmentDir = path.posix.join(ATTACHMENT_DIR, attachment.id);
      const sandboxPath = path.posix.join(
        attachmentDir,
        path.posix.basename(attachment.filename),
      );
      const mkdir = await args.workspace.runCommand({
        cmd: "mkdir",
        args: ["-p", attachmentDir],
      });
      if (mkdir.exitCode !== 0) {
        throw new Error(
          `Failed to create attachment directory: ${mkdir.stderr}`,
        );
      }
      await args.workspace.writeFiles([{ content: data, path: sandboxPath }]);
      return {
        path: sandboxPath,
        filename: attachment.filename,
        mime_type: attachment.contentType,
        bytes: attachment.bytes,
      };
    },
  });
}
