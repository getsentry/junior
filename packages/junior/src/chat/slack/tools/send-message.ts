import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  postSlackMessage,
  uploadFilesToConversation,
} from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { ToolState } from "@/chat/tools/types";

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

const fileInputSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "Sandbox file path to include in the message. Absolute paths and workspace-relative paths are supported.",
    }),
    filename: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
        description:
          "Optional filename override shown in Slack. Null is treated as omitted.",
      }),
    ),
    mimeType: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
        description: "Optional MIME type override. Null is treated as omitted.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SendMessageTarget = "channel" | "thread";

interface SendMessageResult {
  ok: true;
  target: SendMessageTarget;
  channel_id: string;
  file_count?: number;
  file_ids?: string[];
  permalink?: string;
  thread_ts?: string;
  ts?: string;
}

function hasText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

function normalizeSendMessageTarget(target: unknown): SendMessageTarget {
  if (target == null) {
    return "channel";
  }
  if (target === "channel" || target === "thread") {
    return target;
  }
  throw new ToolInputError("sendMessage target must be `channel` or `thread`.");
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

/** Create the current Slack side-effect tool for channel or thread text and file messages. */
export function createSendMessageTool(
  context: SlackToolContext,
  state: ToolState,
  materializeFile: MaterializeMessageFile,
) {
  return tool({
    description:
      "Send a Slack message with optional files. Use target `thread` when the user asks to attach, send, or share files here, in this conversation, or in this thread. Use target `channel` only when the user explicitly asks for a top-level/current-channel post, for example `post this to the channel`. After a successful target `channel` send that satisfies the request, do not add a normal thread acknowledgement; final text should be the no-reply marker. The message can contain text, files, or both; file-only messages are allowed. Do not use for other named channels, inline @mentions, or pinging mentioned users.",
    inputSchema: Type.Object(
      {
        target: Type.Optional(
          Type.Union(
            [Type.Literal("channel"), Type.Literal("thread"), Type.Null()],
            {
              description:
                "Delivery target. `thread` sends into the current Slack thread. `channel` posts a new top-level channel message and requires explicit channel/top-level intent. Text-only messages default to `channel`; messages with files default to `thread`. Null is treated as omitted.",
            },
          ),
        ),
        text: Type.Optional(
          Type.Union([Type.String({ maxLength: 40000 }), Type.Null()], {
            description:
              "Slack mrkdwn text to send. Null is treated as omitted.",
          }),
        ),
        files: Type.Optional(
          Type.Union(
            [Type.Array(fileInputSchema, { minItems: 1 }), Type.Null()],
            {
              description:
                "Sandbox files to include in the message. Null is treated as omitted.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ target, text, files }) => {
      const filesToSend = normalizeMessageFiles(files);
      const deliveryTarget = normalizeSendMessageTarget(
        target ?? (filesToSend.length > 0 ? "thread" : "channel"),
      );
      const targetChannelId =
        deliveryTarget === "thread"
          ? context.sourceChannelId
          : context.destinationChannelId;
      if (!targetChannelId) {
        throw new ToolInputError(
          deliveryTarget === "thread"
            ? "No active Slack source thread is available."
            : "No active Slack destination is available.",
        );
      }
      const threadTs =
        deliveryTarget === "thread"
          ? (context.threadTs ?? context.messageTs)
          : undefined;
      if (deliveryTarget === "thread" && !threadTs) {
        throw new ToolInputError("No active Slack thread is available.");
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
        target: deliveryTarget,
        channel_id: targetChannelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(textToSend ? { text: textToSend } : {}),
        ...(materializedFiles.length > 0
          ? { files: fileOperationInput(materializedFiles) }
          : {}),
      });
      const cached = state.getOperationResult<SendMessageResult>(operationKey);
      if (cached) {
        return {
          ...cached,
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
              channelId: targetChannelId,
              text: textToSend,
              ...(threadTs ? { threadTs } : {}),
              includePermalink: true,
            })
          : undefined;
      const uploaded =
        uploads.length > 0
          ? await uploadFilesToConversation({
              channelId: targetChannelId,
              files: uploads,
              ...(threadTs ? { threadTs } : {}),
              ...(textToSend ? { initialComment: textToSend } : {}),
            })
          : undefined;
      const response = {
        ok: true,
        target: deliveryTarget,
        channel_id: targetChannelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
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
