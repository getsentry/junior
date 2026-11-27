import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import type { ReadAttachmentSource } from "@/chat/attachments/source";
import type { AttachmentDownloadRequest } from "@/chat/attachments/storage";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { readSlackAttachmentSource } from "@/chat/slack/attachments";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { createTranscribeAudioTool } from "@/chat/tools/transcribe-audio";
import { juniorAttachments } from "@/db/schema";
import { filesInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackFileDownloadCalls,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";

const CONVERSATION_ID = "slack:C-transcribe-audio:1";
const OTHER_CONVERSATION_ID = "slack:D-transcribe-audio:other";
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

type ScribeWord = {
  end: number;
  speaker_id: string | null;
  start: number;
  text: string;
  type: "audio_event" | "spacing" | "word";
};

/** One ElevenLabs Scribe token, as AI Gateway returns it. */
function token(
  type: ScribeWord["type"],
  text: string,
  start: number,
  speaker: string | null = "speaker_0",
): ScribeWord {
  return { end: start + 0.3, speaker_id: speaker, start, text, type };
}

/** Words of one sentence, with spaces between them. */
function sentence(text: string, start: number, speaker?: string | null) {
  return text
    .split(" ")
    .flatMap((word, index) => [
      ...(index > 0 ? [token("spacing", " ", start + index, speaker)] : []),
      token("word", word, start + index + 0.1, speaker),
    ]);
}

function scribeResponse(words: ScribeWord[], durationInSeconds = 8) {
  return () =>
    HttpResponse.json({
      durationInSeconds,
      language: "eng",
      providerMetadata: {
        elevenlabs: { words },
        gateway: { cost: "0.00183336", generationId: "gen_transcribe_1" },
      },
      segments: [],
      text: words.map((word) => word.text).join(""),
    });
}

/** Two speakers, a sound between two sentences, and an unlabeled word. */
const diarizedTranscript = scribeResponse(
  [
    token("word", "Okay", 0.4),
    token("spacing", " ", 0.7),
    token("word", "so", 0.8),
    token("spacing", " ", 1.1),
    token("word", "nothing.", 1.2),
    token("audio_event", "[laughter]", 3.4),
    token("word", "Wait,", 4.1),
    token("spacing", " ", 4.4),
    token("word", "there.", 4.5),
    token("spacing", " ", 4.8),
    token("word", "Agreed.", 5.2, "speaker_1"),
    token("audio_event", "[notification chime]", 6.5, null),
    token("word", "Bye.", 3725.04, null),
  ],
  3726,
);

/** Fake sandbox that keeps written files in memory. */
function fakeWorkspace() {
  const files = new Map<string, string>();
  return {
    files,
    writeFiles: async (
      written: Array<{ content: string | Uint8Array; path: string }>,
    ) => {
      for (const file of written) {
        files.set(file.path, Buffer.from(file.content).toString("utf8"));
      }
    },
  };
}

/** Memory storage with the signed reads that S3 and Vercel Blob have. */
function signedStorage() {
  const storage = createMemoryAttachmentStorage();
  const signed: AttachmentDownloadRequest[] = [];
  return {
    objects: storage.objects,
    signed,
    storage: {
      ...storage,
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

function createTool(
  storage: ReturnType<typeof signedStorage>["storage"],
  workspace: Pick<SandboxWorkspace, "writeFiles"> = fakeWorkspace(),
  readAttachmentSource?: ReadAttachmentSource,
) {
  return createTranscribeAudioTool({
    conversationId: CONVERSATION_ID,
    db: getSqlExecutor(),
    modelCost: { conversationId: CONVERSATION_ID },
    modelId: "elevenlabs/scribe-v2",
    ...(readAttachmentSource ? { readAttachmentSource } : undefined),
    storage,
    workspace,
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

  it("sends a fresh signed URL to the model and returns a timed transcript", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const files = signedStorage();
    const stored = await files.store({
      filename: "standup.m4a",
      mimeType: "audio/mp4",
    });
    const requests = gatewayTranscription(diarizedTranscript);
    const workspace = fakeWorkspace();
    const tool = createTool(files.storage, workspace);

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
    const transcript = [
      "[00:00.4] speaker_0: Okay so nothing.",
      "[00:03.4] (laughter)",
      "[00:04.1] speaker_0: Wait, there.",
      "[00:05.2] speaker_1: Agreed.",
      "[00:06.5] (notification chime)",
      "[1:02:05.0] Bye.",
    ].join("\n");
    const transcriptPath = `.junior/attachments/${stored.id}.transcript.txt`;
    expect(result).toEqual({
      duration_seconds: 3726,
      language: "eng",
      transcript,
      transcript_path: transcriptPath,
    });
    expect(workspace.files).toEqual(
      new Map([[transcriptPath, `${transcript}\n`]]),
    );
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

  it("stores a large Slack file on first use and signs its storage key", async () => {
    const files = signedStorage();
    const stored = await files.storeLargeSlackFile();
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0ALLHANDS",
        size: MIB,
        urlPrivate:
          "https://files.slack.com/files-pri/T0TEST-F0ALLHANDS/all-hands.mp4",
      }),
    });
    queueSlackPrivateFileDownload({
      body: new Blob([Buffer.alloc(MIB, 7)]).stream(),
    });
    const requests = gatewayTranscription(diarizedTranscript);

    const result = await createTool(
      files.storage,
      fakeWorkspace(),
      readSlackAttachmentSource,
    ).execute?.({ attachment_id: stored.id }, {});

    const [row] = await getSqlExecutor()
      .db()
      .select({ storageKey: juniorAttachments.storageKey })
      .from(juniorAttachments)
      .where(eq(juniorAttachments.id, stored.id));
    expect(getCapturedSlackFileDownloadCalls()).toHaveLength(1);
    expect([...files.objects.keys()]).toEqual([row?.storageKey]);
    expect(files.signed).toEqual([
      { expiresAtMs: expect.any(Number), key: row?.storageKey },
    ]);
    expect(requests).toEqual([
      expect.objectContaining({
        providerOptions: {
          elevenlabs: expect.objectContaining({ sourceUrl: SIGNED_URL }),
        },
      }),
    ]);
    expect(result).toMatchObject({ language: "eng" });
  });

  it("saves a long transcript and returns the first lines that fit", async () => {
    const files = signedStorage();
    const stored = await files.store({
      filename: "all-hands.m4a",
      mimeType: "audio/mp4",
    });
    const words = Array.from({ length: 3000 }, (_, index) =>
      sentence(`Point "${index}" was made.`, index * 5),
    ).flat();
    gatewayTranscription(scribeResponse(words, 15_000));
    const workspace = fakeWorkspace();

    const result = await createTool(files.storage, workspace).execute?.(
      { attachment_id: stored.id },
      {},
    );

    const saved = workspace.files.get(
      `.junior/attachments/${stored.id}.transcript.txt`,
    );
    const lines = saved?.trimEnd().split("\n") ?? [];
    expect(lines).toHaveLength(3000);
    expect(lines.at(-1)).toBe('[4:09:55.1] speaker_0: Point "2999" was made.');
    expect(result).toMatchObject({ truncated: true });
    const inline = (result as { transcript: string }).transcript;
    const inlineLines = inline.split("\n");
    expect(inlineLines.length).toBeLessThan(3000);
    expect(inlineLines).toEqual(lines.slice(0, inlineLines.length));
    expect(JSON.stringify(result).length).toBeLessThan(32_000);
  });

  it("returns the transcript when the sandbox cannot save it", async () => {
    const files = signedStorage();
    const stored = await files.store({
      filename: "standup.m4a",
      mimeType: "audio/mp4",
    });
    gatewayTranscription(diarizedTranscript);
    const workspace = {
      writeFiles: async () => {
        throw new Error("Sandbox snapshot is not ready.");
      },
    };

    const result = await createTool(files.storage, workspace).execute?.(
      { attachment_id: stored.id },
      {},
    );

    expect(result).toEqual({
      duration_seconds: 3726,
      language: "eng",
      note: "The full transcript was not saved.",
      transcript: expect.stringMatching(
        /^\[00:00\.4\] speaker_0: Okay so nothing\.\n/,
      ),
    });
    expect(logs.map((record) => record.eventName)).toContain(
      "tool.transcript.write.failed",
    );
    expect(JSON.stringify(result)).not.toContain(SIGNED_URL);
    expect(JSON.stringify(logs)).not.toContain(SIGNED_URL);
  });

  it("refuses attachments that it cannot transcribe before it signs a URL", async () => {
    // Private, in another tree and at another Destination.
    await getConversationStore().recordActivity({
      conversationId: OTHER_CONVERSATION_ID,
      destination: { channelId: "DOTHER", platform: "slack", teamId: "TAUDIO" },
      nowMs: 1,
      source: "slack",
      visibility: "private",
    });
    const files = signedStorage();
    const elsewhere = await files.store({
      conversationId: OTHER_CONVERSATION_ID,
      filename: "elsewhere.m4a",
      mimeType: "audio/mp4",
    });
    const document = await files.store({
      filename: "notes.pdf",
      mimeType: "application/pdf",
    });
    const requests = gatewayTranscription(diarizedTranscript);
    const tool = createTool(files.storage);

    await expect(
      tool.execute?.({ attachment_id: elsewhere.id }, {}),
    ).rejects.toThrow(
      new ToolInputError(
        "Attachment not found. Use an attachment_id from the attachment context, a Slack read result, or a Conversation that this one can read.",
      ),
    );
    await expect(
      tool.execute?.({ attachment_id: document.id }, {}),
    ).rejects.toThrow(
      new ToolInputError(
        "This attachment is application/pdf, not audio or video. Use loadAttachment to read other files.",
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
