import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { juniorAttachments } from "@/db/schema";

const CONVERSATION_ID = "slack:C-load-attachment:1";
const MIB = 1024 * 1024;
const run = promisify(execFile);

/** A workspace backed by a local directory, so sandbox commands really run. */
function localWorkspace(root: string): SandboxWorkspace & {
  writes: Array<{ bytes: number; path: string }>;
} {
  const writes: Array<{ bytes: number; path: string }> = [];
  return {
    writes,
    readFileToBuffer: async (input) =>
      await fs.readFile(path.join(root, input.path)),
    runCommand: async (input) => {
      try {
        const { stderr, stdout } = await run(input.cmd, input.args ?? [], {
          cwd: root,
        });
        return { exitCode: 0, stderr, stdout };
      } catch (error) {
        const failed = error as { code?: number; stderr?: string };
        return {
          exitCode: failed.code ?? 1,
          stderr: failed.stderr ?? "",
          stdout: "",
        };
      }
    },
    writeFiles: async (files) => {
      for (const file of files) {
        const target = path.join(root, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content);
        writes.push({
          bytes: Buffer.byteLength(file.content),
          path: file.path,
        });
      }
    },
  };
}

async function recordConversation(): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId: CONVERSATION_ID,
    destination: { channelId: "CLOAD", platform: "slack", teamId: "TLOAD" },
    nowMs: 1,
    source: "slack",
    title: "Load attachment conversation",
    visibility: "public",
  });
}

describe("loadAttachment tool", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-load-attachment-"));
  });

  afterEach(async () => {
    await closeDb();
    await fs.rm(root, { force: true, recursive: true });
  });

  it("restores a stored attachment to the sandbox", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: {
        data: Buffer.from("hello image"),
        filename: "chart.png",
        mimeType: "image/png",
      },
      storage,
    });
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage,
      workspace: localWorkspace(root),
    });

    const result = await tool.execute?.({ attachment_id: stored.id }, {});

    const sandboxPath = `.junior/attachments/${stored.id}/chart.png`;
    expect(result).toMatchObject({
      bytes: 11,
      filename: "chart.png",
      mime_type: "image/png",
      path: sandboxPath,
    });
    expect(await fs.readFile(path.join(root, sandboxPath), "utf8")).toBe(
      "hello image",
    );
    expect(
      await fs.readdir(path.join(root, `.junior/attachments/${stored.id}`)),
    ).toEqual(["chart.png"]);
  });

  it("writes a large attachment to the sandbox in bounded parts", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const data = Buffer.alloc(20 * MIB);
    for (let offset = 0; offset < data.byteLength; offset += MIB) {
      data[offset] = offset / MIB;
    }
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: { data, filename: "trace.bin", mimeType: "application/zip" },
      storage,
    });
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage,
      workspace,
    });

    const result = await tool.execute?.({ attachment_id: stored.id }, {});

    // Memory storage returns the whole object as one chunk. The tool still
    // sends it in 8 MiB parts.
    expect(workspace.writes.map((write) => write.bytes)).toEqual([
      8 * MIB,
      8 * MIB,
      4 * MIB,
    ]);
    const restored = await fs.readFile(
      path.join(root, String((result as { path: string }).path)),
    );
    expect(restored.equals(data)).toBe(true);
    expect(
      await fs.readdir(path.join(root, `.junior/attachments/${stored.id}`)),
    ).toEqual(["trace.bin"]);
    // The joined parts are gone.
    expect(await fs.readdir(path.join(root, ".junior/attachments"))).toEqual([
      stored.id,
    ]);
  });

  it("removes written parts when the stored body ends early", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const data = Buffer.alloc(20 * MIB, 1);
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: { data, filename: "trace.bin", mimeType: "application/zip" },
      storage,
    });
    // One full part reaches the sandbox before the body ends.
    const shortReadStorage = {
      ...storage,
      get: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data.subarray(0, 9 * MIB));
            controller.close();
          },
        }),
    };
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage: shortReadStorage,
      workspace,
    });

    await expect(
      tool.execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow(`read ${9 * MIB} bytes, expected ${20 * MIB}`);
    expect(workspace.writes).toHaveLength(1);
    expect(await fs.readdir(path.join(root, ".junior/attachments"))).toEqual([
      stored.id,
    ]);
    expect(
      await fs.readdir(path.join(root, `.junior/attachments/${stored.id}`)),
    ).toEqual([]);
  });

  it("refuses an attachment over the file limit before it reads storage", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: {
        data: Buffer.from("huge"),
        filename: "huge.mp4",
        mimeType: "video/mp4",
      },
      storage,
    });
    await db
      .db()
      .update(juniorAttachments)
      .set({ bytes: MAX_ATTACHMENT_BYTES + 1 })
      .where(eq(juniorAttachments.id, stored.id));
    const get = vi.spyOn(storage, "get");
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage,
      workspace,
    });

    await expect(
      tool.execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow("larger than the 250 MB file limit");
    expect(get).not.toHaveBeenCalled();
    expect(workspace.writes).toEqual([]);
  });

  it("fails instead of writing a truncated file when storage returns fewer bytes than expected", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const stored = await storeAttachment({
      conversationId: CONVERSATION_ID,
      db,
      file: {
        data: Buffer.from("hello image"),
        filename: "chart.png",
        mimeType: "image/png",
      },
      storage,
    });
    // Simulate an eventually-consistent object storage read (for example, a
    // CDN edge that has not yet propagated a fresh write) that reports
    // success but returns an empty body.
    const emptyReadStorage = {
      ...storage,
      get: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage: emptyReadStorage,
      workspace,
    });

    await expect(
      tool.execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow(/read 0 bytes, expected 11/);
    expect(workspace.writes).toEqual([]);
  });
});
