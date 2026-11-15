import path from "node:path";
import * as z from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
import {
  ATTACHMENT_TOO_LARGE_MESSAGE,
  AttachmentDownloadError,
  readAttachmentContent,
} from "@/chat/attachments/download";
import type { ReadAttachmentSource } from "@/chat/attachments/source";
import { readLiveAttachment } from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type {
  SandboxCommandInput,
  SandboxWorkspace,
} from "@/chat/sandbox/workspace";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const ATTACHMENT_DIR = ".junior/attachments";
/** Bytes held in memory and sent to the sandbox in one write. */
const PART_BYTES = 8 * 1024 * 1024;

// `cat` needs a shell only to redirect its output. Paths stay arguments.
const JOIN_PARTS_SCRIPT = 'set -eu; out=$1; shift; cat -- "$@" > "$out"';

/** Turn a read failure that the model can relay into a tool error. */
function toolError(error: unknown): unknown {
  return error instanceof AttachmentDownloadError
    ? new ToolInputError(error.message, { cause: error })
    : error;
}

/** Run one sandbox command, and return its stdout. Throw when it fails. */
async function runChecked(
  workspace: SandboxWorkspace,
  action: string,
  input: SandboxCommandInput,
): Promise<string> {
  const result = await workspace.runCommand(input);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to ${action}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Write an attachment body to the sandbox in parts of at most `PART_BYTES`.
 *
 * The sandbox SDK writes only whole buffers, so this keeps one part in
 * memory, not the file. Returns the part paths in order.
 */
async function writeParts(args: {
  attachmentId: string;
  body: ReadableStream<Uint8Array>;
  expectedBytes: number;
  partsDir: string;
  workspace: SandboxWorkspace;
}): Promise<string[]> {
  const parts: string[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  const flush = async () => {
    const partPath = path.posix.join(
      args.partsDir,
      String(parts.length).padStart(4, "0"),
    );
    await args.workspace.writeFiles([
      { content: Buffer.concat(pending), path: partPath },
    ]);
    parts.push(partPath);
    pending = [];
    pendingBytes = 0;
  };
  const reader = args.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > args.expectedBytes) break;
      let chunk = value;
      while (pendingBytes + chunk.byteLength >= PART_BYTES) {
        const take = PART_BYTES - pendingBytes;
        pending.push(chunk.subarray(0, take));
        pendingBytes += take;
        await flush();
        chunk = chunk.subarray(take);
      }
      if (chunk.byteLength > 0) {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
      }
    }
  } finally {
    // Close the read when this stops early, so a failed load does not hold
    // a large download open. After a full read this does nothing.
    await reader.cancel().catch(() => undefined);
  }
  if (total !== args.expectedBytes) {
    // A read that returns fewer (or more) bytes than the row or the source
    // reports is corrupt, not a valid empty/short file. Fail loudly instead
    // of silently writing truncated content to the sandbox.
    throw new Error(
      `Attachment ${args.attachmentId} read ${total} bytes, expected ${args.expectedBytes}.`,
    );
  }
  if (pendingBytes > 0 || parts.length === 0) {
    await flush();
  }
  return parts;
}

/**
 * Create a tool that restores one conversation attachment to the sandbox.
 *
 * A large Slack file is never stored: each load streams it from Slack
 * through the host. The sandbox never gets a Slack URL or token.
 *
 * @runBuilt loadAttachment
 */
export function createLoadAttachmentTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  /** Downloads a file that Junior recorded without storing it. */
  readAttachmentSource?: ReadAttachmentSource;
  storage: AttachmentStorage;
  workspace: SandboxWorkspace;
}) {
  return zodTool({
    description:
      "Load a stored attachment for this conversation into the sandbox.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      // A large Slack file downloads from Slack on each load.
      openWorldHint: true,
      readOnlyHint: false,
    },
    inputSchema: z.object({
      attachment_id: z
        .string()
        .min(1)
        .describe(
          "Stored attachment ID, as shown in attachment context or Slack read results.",
        ),
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
      if (attachment.bytes > MAX_ATTACHMENT_BYTES) {
        throw new ToolInputError(ATTACHMENT_TOO_LARGE_MESSAGE);
      }
      let content;
      try {
        content = await readAttachmentContent({
          attachment,
          readAttachmentSource: args.readAttachmentSource,
          storage: args.storage,
        });
      } catch (error) {
        throw toolError(error);
      }
      const attachmentDir = path.posix.join(ATTACHMENT_DIR, attachment.id);
      // Outside the attachment directory, so no filename can collide.
      const partsDir = `${attachmentDir}.parts`;
      const sandboxPath = path.posix.join(
        attachmentDir,
        path.posix.basename(attachment.filename),
      );
      await runChecked(args.workspace, "create attachment directory", {
        cmd: "mkdir",
        args: ["-p", "--", attachmentDir, partsDir],
      });
      // Join into the parts directory and move the file into place only
      // once it is complete, so a failed load never touches a copy that an
      // earlier load wrote.
      const joinedPath = path.posix.join(partsDir, "joined");
      try {
        const parts = await writeParts({
          attachmentId: attachment.id,
          body: await content.open(),
          expectedBytes: content.bytes,
          partsDir,
          workspace: args.workspace,
        });
        await runChecked(args.workspace, "join attachment parts", {
          cmd: "sh",
          args: ["-c", JOIN_PARTS_SCRIPT, "sh", joinedPath, ...parts],
        });
        const size = await runChecked(args.workspace, "read attachment size", {
          cmd: "stat",
          args: ["-c", "%s", "--", joinedPath],
        });
        const written = Number(size.trim());
        if (written !== content.bytes) {
          throw new Error(
            `Attachment ${attachment.id} wrote ${written} bytes to the sandbox, expected ${content.bytes}.`,
          );
        }
        await runChecked(args.workspace, "move attachment into place", {
          cmd: "mv",
          args: ["-f", "--", joinedPath, sandboxPath],
        });
      } catch (error) {
        // The original failure is the one to report, so the cleanup result
        // is ignored.
        await args.workspace
          .runCommand({ cmd: "rm", args: ["-rf", "--", partsDir] })
          .catch(() => undefined);
        throw toolError(error);
      }
      await runChecked(args.workspace, "remove attachment parts", {
        cmd: "rm",
        args: ["-rf", "--", partsDir],
      });
      return {
        path: sandboxPath,
        filename: attachment.filename,
        mime_type: attachment.contentType,
        bytes: content.bytes,
      };
    },
  });
}
