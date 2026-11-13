import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import type { AgentAttachment } from "@/chat/agent/types";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { getConversationStore } from "@/chat/db";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createModelAgentRunnerForRun } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";
import {
  getCapturedSlackFileDownloadCalls,
  queueSlackPrivateFileDownload,
} from "../../msw/handlers/slack-api";

const ORIGINAL_ENV = { ...process.env };
const MIB = 1024 * 1024;
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

async function createRuntime(
  args: Parameters<
    typeof import("../../fixtures/chat-runtime").createTestChatRuntime
  >[0],
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_BOT_USER_TOKEN: "",
    ...env,
  };
  vi.resetModules();
  const { createTestChatRuntime } = await import("../../fixtures/chat-runtime");
  return createTestChatRuntime(args);
}

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
  }

  return String(value);
}

/** A Slack download body that arrives as `count` chunks of one MiB. */
function chunkedDownload(count: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === count) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(MIB).fill(sent));
      sent += 1;
    },
  });
}

/** Record a Slack Conversation that can own stored attachments. */
async function recordSlackConversation(threadTs: string): Promise<string> {
  const conversationId = `slack:C0BEHAVIOR:${threadTs}`;
  await getConversationStore().recordActivity({
    conversationId,
    destination: { channelId: "C0BEHAVIOR", platform: "slack", teamId: "T0" },
    nowMs: 1,
    source: "slack",
    title: "Attachment conversation",
    visibility: "public",
  });
  return conversationId;
}

/** Memory storage that records the size of each chunk that `put` reads. */
function chunkRecordingStorage() {
  const memory = createMemoryAttachmentStorage();
  const putChunks: number[] = [];
  const storage: AttachmentStorage = {
    ...memory,
    put: async (input) =>
      await memory.put({
        ...input,
        body: input.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              putChunks.push(chunk.byteLength);
              controller.enqueue(chunk);
            },
          }),
        ),
      }),
  };
  return { memory, putChunks, storage };
}

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("sends images natively and gives other files a loadAttachment pointer", async () => {
    const imageFetch = vi.fn(async () => PNG_BYTES);

    const capturedAttachments: (readonly AgentAttachment[])[] = [];
    const capturedOmittedImageCounts: number[] = [];

    const { slackRuntime } = await createRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun((request) => {
          capturedAttachments.push(request.instruction.attachments ?? []);
          capturedOmittedImageCounts.push(
            request.instruction.omittedImageAttachmentCount ?? 0,
          );
          return createModelStream([
            { type: "text", text: "Processed attachments." },
          ]);
        }),
        visionContext: { attachmentStorage: createMemoryAttachmentStorage() },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004011.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-2",
      text: "<@U0APP> summarize these files",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
      attachments: [
        {
          type: "image",
          // Slack can mislabel a file; the type detected from the bytes wins.
          mimeType: "image/jpeg",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
        {
          type: "file",
          mimeType: "application/pdf",
          name: "incident.pdf",
          data: Buffer.from("pdf-bytes"),
        },
        {
          type: "video",
          mimeType: "video/mp4",
          name: "repro.mp4",
          data: Buffer.from("mp4-bytes"),
        },
        ...["two.png", "three.png", "four.png"].map((name) => ({
          type: "image",
          mimeType: "image/png",
          name,
          data: Buffer.concat([PNG_BYTES, Buffer.from(name)]),
        })),
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(capturedAttachments).toHaveLength(1);
    const [image, pdf, video, two, three, four] = capturedAttachments[0]!;
    expect(image).toMatchObject({
      data: PNG_BYTES,
      filename: "chart.png",
      mediaType: "image/png",
    });
    // Three images go inline; the fourth is past the cap but still noted.
    expect([two, three].map((file) => file?.data !== undefined)).toEqual([
      true,
      true,
    ]);
    for (const file of [pdf, video, four]) {
      expect(file?.data).toBeUndefined();
      expect(file?.attachmentId).toEqual(expect.any(String));
      expect(file?.promptText).toContain(
        `attachment_id: ${file?.attachmentId}`,
      );
    }
    expect(video).toMatchObject({
      filename: "repro.mp4",
      mediaType: "video/mp4",
    });
    expect(capturedOmittedImageCounts).toEqual([0]);
  });

  it("still runs the assistant when nothing can read the attached images", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const capturedOmittedImageCounts: number[] = [];
    const streamForRun = vi.fn((request) => {
      capturedOmittedImageCounts.push(
        request.instruction.omittedImageAttachmentCount ?? 0,
      );
      return createModelStream([
        {
          type: "text",
          text: "I can’t inspect the attached image in this runtime, but I do see that an image was included.",
        },
      ]);
    });

    const { slackRuntime } = await createRuntime(
      {
        services: {
          agentRunner: createModelAgentRunnerForRun(streamForRun),
        },
      },
      // A text-only profile model with no vision model cannot read images.
      { AI_MODEL: "alibaba/qwen3.7-max" },
    );

    const thread = await createTestThread({
      id: "slack:C0BEHAVIOR:1700004012.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-3",
      text: "<@U0APP> what about this image?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U0TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(streamForRun).toHaveBeenCalledTimes(1);
    expect(capturedOmittedImageCounts).toEqual([1]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I can’t inspect the attached image",
    );
  });
  it("streams a large Slack file into storage and reuses it on a repeat", async () => {
    const { memory, putChunks, storage } = chunkRecordingStorage();
    const { resolveUserAttachments } = createJuniorRuntimeServices({
      visionContext: { attachmentStorage: storage },
    }).visionContext;
    const conversationId = await recordSlackConversation("1700004013.000");
    // The adapter's fetchData buffers the whole file. A streamed file must
    // not use it.
    const fetchData = vi.fn(async () => Buffer.alloc(0));
    const video = {
      type: "video",
      mimeType: "video/mp4",
      name: "repro.mp4",
      size: 6 * MIB,
      url: "https://files.slack.com/files-pri/T0TEST-F0BIGVIDEO/repro.mp4",
      fetchData,
    } as Message["attachments"][number];
    queueSlackPrivateFileDownload({
      body: chunkedDownload(6),
      headers: { "content-type": "video/mp4" },
    });

    const [first] = await resolveUserAttachments([video], { conversationId });

    expect(fetchData).not.toHaveBeenCalled();
    expect(getCapturedSlackFileDownloadCalls()).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer xoxb-test-token",
        }),
      }),
    ]);
    // Storage reads the body in the chunks Slack sent. No step joins them.
    expect(putChunks.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...putChunks)).toBeLessThanOrEqual(MIB);
    expect(putChunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(6 * MIB);
    const [stored] = [...memory.objects.values()];
    expect(stored?.byteLength).toBe(6 * MIB);
    expect(first?.data).toBeUndefined();
    expect(first?.promptText).toContain(
      `attachment_id: ${first?.attachmentId}`,
    );

    // The Slack file id names the stored copy, so the same file again is
    // not downloaded twice.
    const [again] = await resolveUserAttachments([video], { conversationId });

    expect(getCapturedSlackFileDownloadCalls()).toHaveLength(1);
    expect(again?.attachmentId).toBe(first?.attachmentId);
  });

  it("refuses a Slack file over the file limit before it downloads", async () => {
    const storage = createMemoryAttachmentStorage();
    const { resolveUserAttachments } = createJuniorRuntimeServices({
      visionContext: { attachmentStorage: storage },
    }).visionContext;
    const conversationId = await recordSlackConversation("1700004014.000");
    const fetchData = vi.fn(async () => Buffer.alloc(0));

    // More files than the image cap: each one still gets a note.
    const files = await resolveUserAttachments(
      Array.from({ length: 4 }, (_, index) => ({
        type: "file" as const,
        mimeType: "application/octet-stream",
        name: `capture-${index}.pcap`,
        size: MAX_ATTACHMENT_BYTES + 1,
        url: `https://files.slack.com/files-pri/T0TEST-F0HUGE${index}/capture-${index}.pcap`,
        fetchData,
      })),
      { conversationId },
    );

    expect(fetchData).not.toHaveBeenCalled();
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
    expect(storage.objects.size).toBe(0);
    expect(files).toHaveLength(4);
    for (const file of files) {
      expect(file.attachmentId).toBeUndefined();
      expect(file.promptText).toContain("larger than the 250 MB file limit");
    }
  });
});
