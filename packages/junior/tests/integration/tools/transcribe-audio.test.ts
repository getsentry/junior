import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import type { AttachmentDownloadRequest } from "@/chat/attachments/storage";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createTranscribeAudioTool } from "@/chat/tools/transcribe-audio";
import { mswServer } from "../../msw/server";

const CONVERSATION_ID = "slack:C-transcribe-audio:1";
const OTHER_CONVERSATION_ID = "slack:C-transcribe-audio:other";
const TRANSCRIPTION_MODEL_URL =
  "https://ai-gateway.vercel.sh/v4/ai/transcription-model";
// A bearer credential in production. It must stay inside the tool call.
// The key holds "timeout", so a failure message with the URL looks like a
// timeout unless the URL is removed first.
const SIGNED_URL =
  "https://blob.example.test/conversations/standup-timeout.m4a?signature=secret-signature";
const MIB = 1024 * 1024;

type TranscriptionRequest = {
  audio: string;
  providerOptions: {
    elevenlabs: { diarize: boolean; sourceUrl: string };
  };
};

/** Fake AI Gateway transcription endpoint that records each request body. */
function gatewayTranscription(response: () => Response) {
  const requests: TranscriptionRequest[] = [];
  mswServer.use(
    http.post(TRANSCRIPTION_MODEL_URL, async ({ request }) => {
      requests.push((await request.json()) as TranscriptionRequest);
      return response();
    }),
  );
  return requests;
}

/** ElevenLabs Scribe output for two speakers, as AI Gateway returns it. */
function diarizedTranscript() {
  const word = (text: string, start: number, speaker: string) => ({
    end: start + 0.4,
    speaker_id: speaker,
    start,
    text,
    type: "word",
  });
  const space = (start: number, speaker: string) => ({
    end: start + 0.1,
    speaker_id: speaker,
    start,
    text: " ",
    type: "spacing",
  });
  return HttpResponse.json({
    durationInSeconds: 3.2,
    language: "eng",
    providerMetadata: {
      elevenlabs: {
        words: [
          word("Ship", 0, "speaker_0"),
          space(0.4, "speaker_0"),
          word("it.", 0.5, "speaker_0"),
          space(0.9, "speaker_0"),
          word("Agreed.", 1.2, "speaker_1"),
        ],
      },
      gateway: { cost: "0.00183336", generationId: "gen_transcribe_1" },
    },
    segments: [],
    text: "Ship it. Agreed.",
  });
}

/** Memory storage with the signed reads that S3 and Vercel Blob have. */
function signedStorage() {
  const storage = createMemoryAttachmentStorage();
  const signed: AttachmentDownloadRequest[] = [];
  return {
    signed,
    storage: {
      provider: storage.provider,
      createDownloadUrl: async (input: AttachmentDownloadRequest) => {
        signed.push(input);
        return SIGNED_URL;
      },
    },
    store: async (file: {
      conversationId?: string;
      filename: string;
      mimeType: string;
    }) =>
      await storeAttachment({
        conversationId: file.conversationId ?? CONVERSATION_ID,
        db: getSqlExecutor(),
        file: {
          data: Buffer.from("audio bytes"),
          filename: file.filename,
          mimeType: file.mimeType,
        },
        storage,
      }),
    storeLargeSlackFile: async () =>
      await storeAttachment({
        conversationId: CONVERSATION_ID,
        db: getSqlExecutor(),
        file: {
          bytes: 30 * MIB,
          deferred: true,
          filename: "all-hands.mp4",
          mimeType: "video/mp4",
          source: { id: "F0ALLHANDS", provider: "slack" },
        },
        storage,
      }),
  };
}

async function recordConversation(conversationId: string): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { channelId: "CAUDIO", platform: "slack", teamId: "TAUDIO" },
    nowMs: 1,
    source: "slack",
    title: "Transcribe audio conversation",
    visibility: "public",
  });
}

function createTool(storage: ReturnType<typeof signedStorage>["storage"]) {
  return createTranscribeAudioTool({
    conversationId: CONVERSATION_ID,
    db: getSqlExecutor(),
    modelCost: { conversationId: CONVERSATION_ID },
    modelId: "elevenlabs/scribe-v2",
    storage,
  });
}

describe("transcribeAudio tool", () => {
  let logs: EmittedLogRecord[];
  let unregisterLogs: () => void;

  beforeEach(async () => {
    logs = [];
    unregisterLogs = registerLogRecordSink((record) => logs.push(record));
    await recordConversation(CONVERSATION_ID);
  });

  afterEach(async () => {
    unregisterLogs();
    vi.useRealTimers();
    await closeDb();
  });

  it("sends a fresh signed URL to the model and returns speaker segments", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const files = signedStorage();
    const stored = await files.store({
      filename: "standup.m4a",
      mimeType: "audio/mp4",
    });
    const requests = gatewayTranscription(diarizedTranscript);
    const tool = createTool(files.storage);

    const result = await tool.execute?.({ attachment_id: stored.id }, {});

    expect(files.signed).toEqual([
      { expiresAtMs: 1_800_000_300_000, key: expect.any(String) },
    ]);
    // ElevenLabs downloads the file. The request has no audio bytes.
    expect(requests).toEqual([
      expect.objectContaining({
        audio: "",
        providerOptions: {
          elevenlabs: expect.objectContaining({
            diarize: true,
            sourceUrl: SIGNED_URL,
          }),
        },
      }),
    ]);
    expect(result).toEqual({
      duration_seconds: 3.2,
      language: "eng",
      segments: [
        {
          end_seconds: 0.9,
          speaker: "speaker_0",
          start_seconds: 0,
          text: "Ship it.",
        },
        {
          end_seconds: 1.6,
          speaker: "speaker_1",
          start_seconds: 1.2,
          text: "Agreed.",
        },
      ],
      text: "Ship it. Agreed.",
    });
    const { events } = await getConversationEventStore().query(
      CONVERSATION_ID,
      { limit: 10, types: ["structured_event"] },
    );
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({
        content: { costUsd: 0.00183336 },
        name: "transcription",
        namespace: "junior",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(SIGNED_URL);
    expect(JSON.stringify(logs)).not.toContain(SIGNED_URL);
  });

  it("refuses attachments that it cannot transcribe before it signs a URL", async () => {
    await recordConversation(OTHER_CONVERSATION_ID);
    const files = signedStorage();
    const elsewhere = await files.store({
      conversationId: OTHER_CONVERSATION_ID,
      filename: "elsewhere.m4a",
      mimeType: "audio/mp4",
    });
    const largeSlackFile = await files.storeLargeSlackFile();
    const document = await files.store({
      filename: "notes.pdf",
      mimeType: "application/pdf",
    });
    const requests = gatewayTranscription(diarizedTranscript);
    const tool = createTool(files.storage);

    await expect(
      tool.execute?.({ attachment_id: elsewhere.id }, {}),
    ).rejects.toThrow(
      new ToolInputError("Attachment not found in this conversation."),
    );
    await expect(
      tool.execute?.({ attachment_id: largeSlackFile.id }, {}),
    ).rejects.toThrow(
      new ToolInputError(
        "This attachment is not available for transcription yet. Large Slack files are not stored.",
      ),
    );
    await expect(
      tool.execute?.({ attachment_id: document.id }, {}),
    ).rejects.toThrow(
      new ToolInputError(
        "This attachment is application/pdf, not audio or video.",
      ),
    );
    expect(files.signed).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reports a video with no audio track as a tool error", async () => {
    const files = signedStorage();
    const stored = await files.store({
      filename: "screen-recording.mp4",
      mimeType: "video/mp4",
    });
    gatewayTranscription(() =>
      HttpResponse.json(
        {
          error: {
            message:
              "File is corrupted. Please ensure it is playable audio. (invalid_audio)",
            type: "AI_APICallError",
          },
        },
        { status: 400 },
      ),
    );

    await expect(
      createTool(files.storage).execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow(
      new ToolInputError("The file has no audio to transcribe."),
    );
  });

  it("keeps the signed URL out of a failed call's error and logs", async () => {
    const files = signedStorage();
    const stored = await files.store({
      filename: "standup.m4a",
      mimeType: "audio/mp4",
    });
    gatewayTranscription(() =>
      HttpResponse.json(
        {
          error: {
            message: `Failed to download the file from ${SIGNED_URL} (bad_request)`,
            type: "AI_APICallError",
          },
        },
        { status: 400 },
      ),
    );

    const error = await Promise.resolve(
      createTool(files.storage).execute?.({ attachment_id: stored.id }, {}),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "invalid_request", status: 400 });
    const chain: string[] = [];
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      chain.push(cause.message, JSON.stringify(cause));
    }
    expect(chain.join("\n")).not.toContain(SIGNED_URL);
    expect(logs.map((record) => record.eventName)).toContain(
      "ai.transcription.failed",
    );
    expect(JSON.stringify(logs)).not.toContain(SIGNED_URL);
  });
});
