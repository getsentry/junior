import * as z from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { readLiveAttachment } from "@/chat/attachments/store";
import { attachmentIdParam } from "@/chat/attachments/tool-params";
import {
  transcribeFromUrl,
  type ConversationModelCost,
} from "@/chat/core-model";
import { NoAudioError } from "@/chat/pi/transcription";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Deferred tool catalog source for speech transcription. */
const AUDIO_TOOL_SOURCE = {
  id: "audio",
  description: "Transcribe speech in audio and video attachments.",
} as const;

// The provider starts its download when the request arrives, so a short
// expiry is enough. Each call signs a new URL.
const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

// Slack and browsers label some audio with no specific type.
const UNTYPED_CONTENT_TYPE = "application/octet-stream";

const transcribeAudioOutputSchema = juniorToolOutputSchema
  .extend({
    text: z.string(),
    language: z.string().optional(),
    duration_seconds: z.number().nonnegative().optional(),
    segments: z.array(
      z
        .object({
          start_seconds: z.number().nonnegative(),
          end_seconds: z.number().nonnegative(),
          speaker: z.string().optional(),
          text: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

/** Storage that can sign a download URL for an outside service. */
type SignedDownloadStorage = Pick<AttachmentStorage, "provider"> &
  Required<Pick<AttachmentStorage, "createDownloadUrl">>;

function mayHaveAudio(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/") ||
    mediaType === UNTYPED_CONTENT_TYPE
  );
}

/**
 * Create a tool that transcribes speech in one Conversation attachment.
 *
 * The model provider downloads the file from a short-lived signed URL, so
 * the file never passes through the host. The URL never leaves this call.
 *
 * @runBuilt transcribeAudio
 */
export function createTranscribeAudioTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  modelCost: ConversationModelCost;
  modelId: string;
  storage: SignedDownloadStorage;
}) {
  return zodTool({
    exposure: "deferred",
    source: AUDIO_TOOL_SOURCE,
    description:
      "Transcribe speech in an audio or video attachment. Returns the text, its language and duration, and timed segments with speaker labels.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      attachment_id: attachmentIdParam,
    }),
    outputSchema: transcribeAudioOutputSchema,
    execute: async ({ attachment_id }, { signal }) => {
      const attachment = await readLiveAttachment({
        attachmentId: attachment_id,
        conversationId: args.conversationId,
        db: args.db,
      });
      if (!attachment || attachment.storageProvider !== args.storage.provider) {
        throw new ToolInputError("Attachment not found in this conversation.");
      }
      if (!attachment.storageKey) {
        throw new ToolInputError(
          "This attachment is not available for transcription yet. Large Slack files are not stored.",
        );
      }
      if (!mayHaveAudio(attachment.contentType)) {
        throw new ToolInputError(
          `This attachment is ${attachment.contentType}, not audio or video.`,
        );
      }
      const sourceUrl = await args.storage.createDownloadUrl({
        expiresAtMs: Date.now() + DOWNLOAD_URL_TTL_MS,
        key: attachment.storageKey,
      });
      const transcript = await transcribeFromUrl({
        cost: args.modelCost,
        modelId: args.modelId,
        operation: "transcription",
        signal,
        sourceUrl,
      }).catch((error: unknown) => {
        if (error instanceof NoAudioError) {
          throw new ToolInputError(error.message, { cause: error });
        }
        throw error;
      });
      return {
        text: transcript.text,
        ...(transcript.language
          ? { language: transcript.language }
          : undefined),
        ...(transcript.durationSeconds !== undefined
          ? { duration_seconds: transcript.durationSeconds }
          : undefined),
        segments: transcript.segments.map((segment) => ({
          start_seconds: segment.startSeconds,
          end_seconds: segment.endSeconds,
          ...(segment.speaker ? { speaker: segment.speaker } : undefined),
          text: segment.text,
        })),
      };
    },
  });
}
