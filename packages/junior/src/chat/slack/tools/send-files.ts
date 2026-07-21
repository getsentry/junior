import { createHash } from "node:crypto";
import { uploadFilesToConversation } from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { ToolState } from "@/chat/tools/types";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";

/** Convert a model-supplied sandbox file path into bytes safe for Slack upload. */
export type MaterializeFile = (input: {
  path: string;
  filename?: string;
  mimeType?: string;
}) => Promise<SandboxFileUpload>;

type FileInput = {
  path: string;
  filename?: string | null;
  mimeType?: string | null;
};

const fileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Sandbox file path to include in the message. Absolute paths and workspace-relative paths are supported.",
    ),
  filename: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Optional filename override shown in Slack. Null is treated as omitted.",
    ),
  mimeType: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("Optional MIME type override. Null is treated as omitted."),
});

const sendFilesDataSchema = z.object({
  channel_id: z.string().min(1),
  deduplicated: z.boolean().optional(),
  file_count: z.number().int().nonnegative(),
  file_ids: z.array(z.string().min(1)).optional(),
  thread_ts: z.string().min(1),
});

const sendFilesResultSchema = juniorToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.string().min(1),
  data: sendFilesDataSchema,
});

type SendFilesResult = z.output<typeof sendFilesResultSchema>;

function normalizeFiles(
  files: FileInput[],
): Array<{ path: string; filename?: string; mimeType?: string }> {
  return files.map((file) => ({
    path: file.path,
    ...(file.filename ? { filename: file.filename } : {}),
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
  }));
}

function fileContentDigest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Include file bytes in idempotency so rewritten paths can be sent again. */
function fileOperationInput(files: SandboxFileUpload[]) {
  return files.map((file) => ({
    bytes: file.bytes,
    filename: file.filename,
    mimeType: file.mimeType,
    path: file.path,
    sha256: fileContentDigest(file.data),
  }));
}

/** Create the Slack side-effect tool for active-conversation file messages. */
export function createSendFilesTool(
  context: SlackToolContext,
  state: ToolState,
  materializeFile: MaterializeFile,
) {
  return zodTool({
    description:
      "Send one or more sandbox files into the active Slack conversation. Use when the user asks to attach, send, or share files here, in this conversation, or in this thread. Do not use for ordinary assistant text, top-level channel posts, other named channels, inline @mentions, or pinging mentioned users.",
    inputSchema: z.object({
      files: z
        .array(fileInputSchema)
        .min(1)
        .describe("One or more sandbox files to include in the message."),
    }),
    outputSchema: sendFilesResultSchema,
    execute: async ({ files }) => {
      const filesToSend = normalizeFiles(files);
      const activeChannelId = context.sourceChannelId;
      if (!activeChannelId) {
        throw new ToolInputError("No active Slack conversation is available.");
      }
      const threadTs = context.threadTs ?? context.messageTs;
      if (!threadTs) {
        throw new ToolInputError(
          "No active Slack conversation timestamp is available.",
        );
      }
      const materializedFiles = await Promise.all(
        filesToSend.map((file) => materializeFile(file)),
      );
      const operationKey = createOperationKey("sendFiles", {
        channel_id: activeChannelId,
        thread_ts: threadTs,
        files: fileOperationInput(materializedFiles),
      });
      const cached = state.getOperationResult<SendFilesResult>(operationKey);
      if (cached) {
        return sendFilesResultSchema.parse({
          ...cached,
          data: {
            ...cached.data,
            deduplicated: true,
          },
        });
      }

      const uploads = materializedFiles.map((file) => ({
        data: file.data,
        filename: file.filename,
      }));
      const uploaded = await uploadFilesToConversation({
        channelId: activeChannelId,
        files: uploads,
        threadTs,
      });
      const fileIds = uploaded?.files
        ?.map((file) => file.id)
        .filter((id): id is string => Boolean(id));
      const response: SendFilesResult = {
        ok: true,
        status: "success" as const,
        target: `${activeChannelId}:${threadTs}`,
        data: {
          channel_id: activeChannelId,
          thread_ts: threadTs,
          file_count: uploads.length,
          ...(fileIds ? { file_ids: fileIds } : {}),
        },
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
