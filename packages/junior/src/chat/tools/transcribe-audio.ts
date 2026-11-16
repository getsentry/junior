import path from "node:path";
import * as z from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  AttachmentDownloadError,
  storeAttachmentOnFirstUse,
} from "@/chat/attachments/download";
import type { ReadAttachmentSource } from "@/chat/attachments/source";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { readLiveAttachment } from "@/chat/attachments/store";
import { attachmentIdParam } from "@/chat/attachments/tool-params";
import {
  transcribeFromUrl,
  type ConversationModelCost,
} from "@/chat/core-model";
import { NoAudioError, type TranscriptEntry } from "@/chat/pi/transcription";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { TOOL_RESULT_MAX_CHARS } from "@/chat/tool-support/result-cap";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { logWarn } from "@/chat/logging";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { ATTACHMENT_DIR } from "@/chat/tools/load-attachment";

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

// Room for fields that the runtime adds to a result, such as continuation.
const INLINE_RESERVE_CHARS = 1_000;

const transcribeAudioOutputSchema = juniorToolOutputSchema
  .extend({
    transcript: z.string(),
    transcript_path: z.string().optional(),
    note: z.string().optional(),
    language: z.string().optional(),
    duration_seconds: z.number().nonnegative().optional(),
  })
  .strict();

/** Storage that can sign a download URL for an outside service. */
type SignedDownloadStorage = AttachmentStorage &
  Required<Pick<AttachmentStorage, "createDownloadUrl">>;

function mayHaveAudio(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/") ||
    mediaType === UNTYPED_CONTENT_TYPE
  );
}

/** Format seconds as `MM:SS.s`, or `H:MM:SS.s` from one hour. */
function timestamp(seconds: number): string {
  const tenths = Math.floor(seconds * 10);
  const hours = Math.floor(tenths / 36_000);
  const minutes = String(Math.floor(tenths / 600) % 60).padStart(2, "0");
  const secs = String(Math.floor(tenths / 10) % 60).padStart(2, "0");
  const time = `${minutes}:${secs}.${tenths % 10}`;
  return hours > 0 ? `${hours}:${time}` : time;
}

/** One log-style line per entry: start time, then speaker and text. */
function transcriptLine(entry: TranscriptEntry): string {
  const text = entry.text.replace(/\s+/g, " ");
  const body =
    entry.kind === "sound"
      ? `(${text})`
      : entry.speaker
        ? `${entry.speaker}: ${text}`
        : text;
  return `[${timestamp(entry.startSeconds)}] ${body}`;
}

/**
 * Keep the leading lines whose JSON-escaped size fits in `budget` chars.
 * The cut is always on a line boundary.
 */
function leadingLines(
  lines: string[],
  budget: number,
): { text: string; truncated: boolean } {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    // JSON quotes cost 2 chars. The escaped newline before a line costs 2.
    used += JSON.stringify(line).length - 2 + (count > 0 ? 2 : 0);
    if (used > budget) break;
    count += 1;
  }
  return {
    text: lines.slice(0, count).join("\n"),
    truncated: count < lines.length,
  };
}

/**
 * Create a tool that transcribes speech in one Conversation attachment.
 *
 * The model provider downloads the file from a short-lived signed URL. The
 * URL never leaves this call. A large Slack file is stored first, so its
 * first transcription streams it through the host once.
 *
 * @runBuilt transcribeAudio
 */
export function createTranscribeAudioTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  modelCost: ConversationModelCost;
  modelId: string;
  /** Downloads a file that Junior recorded without storing it yet. */
  readAttachmentSource?: ReadAttachmentSource;
  storage: SignedDownloadStorage;
  workspace: Pick<SandboxWorkspace, "writeFiles">;
}) {
  return zodTool({
    exposure: "deferred",
    source: AUDIO_TOOL_SOURCE,
    description:
      "Transcribe speech in an audio or video attachment. Returns a transcript with one line per entry: `[MM:SS.s] speaker: text` for speech and `[MM:SS.s] (sound)` for sounds. The full transcript is saved at `transcript_path`. When `truncated` is true, the inline transcript has only the first lines: read the rest of the file with readFile, or search it with grep. When the save fails, `transcript_path` is absent and `note` says so.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      // The transcript file is scratch output in Junior's own sandbox, like
      // the file that a cut tool result writes. Nothing outside changes.
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
      if (!mayHaveAudio(attachment.contentType)) {
        throw new ToolInputError(
          `This attachment is ${attachment.contentType}, not audio or video.`,
        );
      }
      const { storageKey } = await storeAttachmentOnFirstUse({
        attachment,
        db: args.db,
        readAttachmentSource: args.readAttachmentSource,
        storage: args.storage,
      }).catch((error: unknown) => {
        if (error instanceof AttachmentDownloadError) {
          throw new ToolInputError(error.message, { cause: error });
        }
        throw error;
      });
      const sourceUrl = await args.storage.createDownloadUrl({
        expiresAtMs: Date.now() + DOWNLOAD_URL_TTL_MS,
        key: storageKey,
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
      const lines = transcript.entries.map(transcriptLine);
      const transcriptPath = path.posix.join(
        ATTACHMENT_DIR,
        `${attachment.id}.transcript.txt`,
      );
      // A failed write still returns the transcript. The model was already
      // paid for, and the inline lines are useful without the file.
      let saved = true;
      try {
        // Sandbox writes create missing parent directories.
        await args.workspace.writeFiles([
          { content: `${lines.join("\n")}\n`, path: transcriptPath },
        ]);
      } catch (error) {
        saved = false;
        logWarn("tool.transcript.write.failed", {
          "exception.message": String(error),
        });
      }
      const result = {
        ...(saved
          ? { transcript_path: transcriptPath }
          : { note: "The full transcript was not saved." }),
        ...(transcript.language
          ? { language: transcript.language }
          : undefined),
        ...(transcript.durationSeconds !== undefined
          ? { duration_seconds: transcript.durationSeconds }
          : undefined),
      };
      const inline = leadingLines(
        lines,
        TOOL_RESULT_MAX_CHARS -
          INLINE_RESERVE_CHARS -
          JSON.stringify({ ...result, transcript: "", truncated: true }).length,
      );
      return {
        ...result,
        transcript: inline.text,
        ...(inline.truncated ? { truncated: true } : undefined),
      };
    },
  });
}
