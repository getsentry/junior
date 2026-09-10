import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { storeAttachment } from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";

const CONVERSATION_ID = "slack:C-load-attachment:1";

function workspace(): SandboxWorkspace & {
  written: Array<{ content: Buffer; path: string }>;
} {
  const written: Array<{ content: Buffer; path: string }> = [];
  return {
    written,
    readFileToBuffer: vi.fn(async () => null),
    runCommand: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    writeFiles: vi.fn(async (files: Array<{ content: Buffer; path: string }>) => {
      written.push(
        ...files.map((file) => ({ content: file.content, path: file.path })),
      );
    }),
  };
}

/** Object storage double whose `get` can be forced to return truncated bytes. */
function memoryAttachmentStorage(): AttachmentStorage & {
  objects: Map<string, Buffer>;
  truncateNextRead?: number;
} {
  const state: AttachmentStorage & {
    objects: Map<string, Buffer>;
    truncateNextRead?: number;
  } = {
    objects: new Map<string, Buffer>(),
    provider: "test",
    truncateNextRead: undefined,
    async put(input) {
      state.objects.set(input.key, Buffer.from(input.body));
    },
    async get(key) {
      const body = state.objects.get(key);
      if (!body) return null;
      const bytes =
        state.truncateNextRead !== undefined
          ? body.subarray(0, state.truncateNextRead)
          : body;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async delete(keys) {
      for (const key of keys) state.objects.delete(key);
    },
  };
  return state;
}

describe("loadAttachment tool", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("restores a stored attachment to the sandbox", async () => {
    const storage = memoryAttachmentStorage();
    const db = getSqlExecutor();
    await getConversationStore().recordActivity({
      conversationId: CONVERSATION_ID,
      destination: { channelId: "CLOAD", platform: "slack", teamId: "TLOAD" },
      nowMs: 1,
      source: "slack",
      title: "Load attachment conversation",
      visibility: "public",
    });
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: {
        bytes: 11,
        data: Buffer.from("hello image"),
        filename: "chart.png",
        mimeType: "image/png",
        path: "/tmp/chart.png",
      },
      storage,
    });
    const sandboxWorkspace = workspace();
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage,
      workspace: sandboxWorkspace,
    });

    const result = await tool.execute?.({ attachment_id: stored.id }, {});

    expect(result).toMatchObject({
      bytes: 11,
      filename: "chart.png",
      mime_type: "image/png",
      path: `.junior/attachments/${stored.id}/chart.png`,
    });
    expect(sandboxWorkspace.written).toEqual([
      {
        content: Buffer.from("hello image"),
        path: `.junior/attachments/${stored.id}/chart.png`,
      },
    ]);
  });

  it("fails instead of writing a truncated file when storage returns fewer bytes than expected", async () => {
    const storage = memoryAttachmentStorage();
    const db = getSqlExecutor();
    await getConversationStore().recordActivity({
      conversationId: CONVERSATION_ID,
      destination: { channelId: "CLOAD", platform: "slack", teamId: "TLOAD" },
      nowMs: 1,
      source: "slack",
      title: "Load attachment conversation",
      visibility: "public",
    });
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: {
        bytes: 11,
        data: Buffer.from("hello image"),
        filename: "chart.png",
        mimeType: "image/png",
        path: "/tmp/chart.png",
      },
      storage,
    });
    // Simulate an eventually-consistent object storage read (for example, a
    // CDN edge that has not yet propagated a fresh write) that reports
    // success but returns an empty body.
    storage.truncateNextRead = 0;
    const sandboxWorkspace = workspace();
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage,
      workspace: sandboxWorkspace,
    });

    await expect(
      tool.execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow(/read 0 bytes, expected 11/);
    expect(sandboxWorkspace.written).toEqual([]);
  });
});
