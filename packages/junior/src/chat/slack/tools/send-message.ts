import { createHash } from "node:crypto";
import {
  postSlackMessage,
  uploadFilesToConversation,
} from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { ToolState } from "@/chat/tools/types";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";

/** Convert a model-supplied sandbox file path into bytes safe for Slack upload. */
export type MaterializeMessageFile = (input: {
  path: string;
  filename?: string;
  mimeType?: string;
}) => Promise<SandboxFileUpload>;

type MessageFileInput = {
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

interface SendMessageResult {
  ok: true;
  status: "success";
  target: string;
  data: {
    channel_id: string;
    deduplicated?: boolean;
    file_count?: number;
    file_ids?: string[];
    permalink?: string;
    thread_ts?: string;
    ts?: string;
  };
  channel_id: string;
  deduplicated?: boolean;
  file_count?: number;
  file_ids?: string[];
  permalink?: string;
  thread_ts?: string;
  ts?: string;
}

function hasText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

function normalizeMessageFiles(
  files: MessageFileInput[] | null | undefined,
): Array<{ path: string; filename?: string; mimeType?: string }> {
  return (files ?? []).map((file) => ({
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

/** Create the Slack side-effect tool for active-conversation text and file messages. */
export function createSendMessageTool(
  context: SlackToolContext,
  state: ToolState,
  materializeFile: MaterializeMessageFile,
) {
  return zodTool({
    description:
      "Send a Slack message with optional files into the active Slack conversation. Use when the user asks to attach, send, or share files here, in this conversation, or in this thread. The message can contain text, files, or both; file-only messages are allowed. Do not use for top-level channel posts, other named channels, inline @mentions, or pinging mentioned users.",
    inputSchema: z.object({
      text: z
        .string()
        .max(40000)
        .nullable()
        .optional()
        .describe("Slack mrkdwn text to send. Null is treated as omitted."),
      files: z
        .array(fileInputSchema)
        .min(1)
        .nullable()
        .optional()
        .describe(
          "Sandbox files to include in the message. Null is treated as omitted.",
        ),
    }),
    outputSchema: juniorToolResultSchema,
    execute: async ({ text, files }) => {
      const filesToSend = normalizeMessageFiles(files);
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
      const textToSend = hasText(text) ? text : undefined;
      if (!textToSend && filesToSend.length === 0) {
        throw new ToolInputError(
          "sendMessage requires text or at least one file.",
        );
      }

      const materializedFiles = await Promise.all(
        filesToSend.map((file) => materializeFile(file)),
      );
      const operationKey = createOperationKey("sendMessage", {
        channel_id: activeChannelId,
        thread_ts: threadTs,
        ...(textToSend ? { text: textToSend } : {}),
        ...(materializedFiles.length > 0
          ? { files: fileOperationInput(materializedFiles) }
          : {}),
      });
      const cached = state.getOperationResult<SendMessageResult>(operationKey);
      if (cached) {
        return {
          ...cached,
          data: {
            ...cached.data,
            deduplicated: true,
          },
          deduplicated: true,
        };
      }

      const uploads = materializedFiles.map((file) => ({
        data: file.data,
        filename: file.filename,
      }));
      const posted =
        uploads.length === 0 && textToSend
          ? await postSlackMessage({
              channelId: activeChannelId,
              text: textToSend,
              threadTs,
              includePermalink: true,
            })
          : undefined;
      const uploaded =
        uploads.length > 0
          ? await uploadFilesToConversation({
              channelId: activeChannelId,
              files: uploads,
              threadTs,
              ...(textToSend ? { initialComment: textToSend } : {}),
            })
          : undefined;
      const response = {
        ok: true,
        status: "success" as const,
        target: `${activeChannelId}:${threadTs}`,
        data: {
          channel_id: activeChannelId,
          thread_ts: threadTs,
          ...(posted ? { ts: posted.ts, permalink: posted.permalink } : {}),
          ...(uploads.length > 0 ? { file_count: uploads.length } : {}),
          ...(uploaded?.files
            ? {
                file_ids: uploaded.files
                  .map((file) => file.id)
                  .filter((id): id is string => Boolean(id)),
              }
            : {}),
        },
        channel_id: activeChannelId,
        thread_ts: threadTs,
        ...(posted ? { ts: posted.ts, permalink: posted.permalink } : {}),
        ...(uploads.length > 0 ? { file_count: uploads.length } : {}),
        ...(uploaded?.files
          ? {
              file_ids: uploaded.files
                .map((file) => file.id)
                .filter((id): id is string => Boolean(id)),
            }
          : {}),
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
