import path from "node:path";
import * as z from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
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
 * Write a stored body to the sandbox in parts of at most `PART_BYTES`.
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > args.expectedBytes) {
      await reader.cancel();
      break;
    }
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
  if (total !== args.expectedBytes) {
    // A storage read that returns fewer (or more) bytes than the durable
    // row expects is corrupt, not a valid empty/short file. Fail loudly
    // instead of silently writing truncated content to the sandbox.
    throw new Error(
      `Attachment ${args.attachmentId} read ${total} bytes, expected ${args.expectedBytes}.`,
    );
  }
  if (pendingBytes > 0 || parts.length === 0) {
    await flush();
  }
  return parts;
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
      if (attachment.bytes > MAX_ATTACHMENT_BYTES) {
        throw new ToolInputError(
          `Attachment is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB file limit.`,
        );
      }
      const body = await args.storage.get(attachment.storageKey);
      if (!body) {
        throw new ToolInputError("Stored attachment contents are unavailable.");
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
      const parts = await writeParts({
        attachmentId: attachment.id,
        body,
        expectedBytes: attachment.bytes,
        partsDir,
        workspace: args.workspace,
      });
      await runChecked(args.workspace, "join attachment parts", {
        cmd: "sh",
        args: ["-c", JOIN_PARTS_SCRIPT, "sh", sandboxPath, ...parts],
      });
      await runChecked(args.workspace, "remove attachment parts", {
        cmd: "rm",
        args: ["-rf", "--", partsDir],
      });
      const size = await runChecked(args.workspace, "read attachment size", {
        cmd: "stat",
        args: ["-c", "%s", "--", sandboxPath],
      });
      const written = Number(size.trim());
      if (written !== attachment.bytes) {
        throw new Error(
          `Attachment ${attachment.id} wrote ${written} bytes to the sandbox, expected ${attachment.bytes}.`,
        );
      }
      return {
        path: sandboxPath,
        filename: attachment.filename,
        mime_type: attachment.contentType,
        bytes: attachment.bytes,
      };
    },
  });
}
