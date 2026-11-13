import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
import { ATTACHMENT_TOO_LARGE_MESSAGE } from "@/chat/attachments/download";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { readSlackAttachmentSource } from "@/chat/slack/attachments";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { juniorAttachments } from "@/db/schema";
import { filesInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileDownloadCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../../msw/handlers/slack-api";

const CONVERSATION_ID = "slack:C-load-attachment:1";
const MIB = 1024 * 1024;
const run = promisify(execFile);

/** A workspace backed by a local directory, so sandbox commands really run. */
function localWorkspace(root: string): SandboxWorkspace & {
  commands: string[];
  writes: Array<{ bytes: number; path: string }>;
} {
  const commands: string[] = [];
  const writes: Array<{ bytes: number; path: string }> = [];
  return {
    commands,
    writes,
    readFileToBuffer: async (input) =>
      await fs.readFile(path.join(root, input.path)),
    runCommand: async (input) => {
      commands.push([input.cmd, ...(input.args ?? [])].join(" "));
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

/** `count` distinct one-MiB chunks. */
function* chunks(count: number): Generator<Buffer> {
  for (let index = 0; index < count; index += 1) {
    yield Buffer.alloc(MIB, index);
  }
}

/** A Slack download body that arrives in one-MiB chunks. */
function chunkedBody(count: number): ReadableStream<Uint8Array> {
  const source = chunks(count);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = source.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
}

/** Record a large Slack file the way ingest does: a row with no object. */
async function recordLargeSlackFile(args: {
  conversationId?: string;
  db: ReturnType<typeof getSqlExecutor>;
  fileId: string;
  storage: ReturnType<typeof createMemoryAttachmentStorage>;
}) {
  return await storeAttachment({
    conversationId: args.conversationId ?? CONVERSATION_ID,
    db: args.db,
    file: {
      bytes: 30 * MIB,
      deferred: true,
      filename: "standup.mp4",
      mimeType: "video/mp4",
      source: { id: args.fileId, provider: "slack" },
    },
    storage: args.storage,
  });
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

  it("keeps the loaded copy and removes parts when a reload ends early", async () => {
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
    const loaded = await createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage,
      workspace,
    }).execute?.({ attachment_id: stored.id }, {});
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      storage: shortReadStorage,
      workspace,
    });

    await expect(
      tool.execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow(`read ${9 * MIB} bytes, expected ${20 * MIB}`);
    expect(await fs.readdir(path.join(root, ".junior/attachments"))).toEqual([
      stored.id,
    ]);
    expect(
      (
        await fs.readFile(
          path.join(root, String((loaded as { path: string }).path)),
        )
      ).equals(data),
    ).toBe(true);
  });

  it("streams a large Slack file from Slack on every load and never stores it", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const stored = await recordLargeSlackFile({
      db,
      fileId: "F0STANDUP",
      storage,
    });
    const url =
      "https://files.slack.com/files-pri/T0TEST-F0STANDUP/standup.mp4";
    for (let load = 0; load < 2; load += 1) {
      queueSlackApiResponse("files.info", {
        body: filesInfoOk({
          fileId: "F0STANDUP",
          size: 20 * MIB,
          urlPrivate: url,
        }),
      });
      queueSlackPrivateFileDownload({ body: chunkedBody(20) });
    }
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      readAttachmentSource: readSlackAttachmentSource,
      storage,
      workspace,
    });

    const first = await tool.execute?.({ attachment_id: stored.id }, {});
    const second = await tool.execute?.({ attachment_id: stored.id }, {});

    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(2);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([
      expect.objectContaining({ url }),
      expect.objectContaining({ url }),
    ]);
    expect(second).toEqual(first);
    expect(first).toEqual(expect.objectContaining({ bytes: 20 * MIB }));
    const loaded = await fs.readFile(
      path.join(root, String((first as { path: string }).path)),
    );
    expect(loaded.equals(Buffer.concat([...chunks(20)]))).toBe(true);
    // The sandbox gets bytes only: no Slack URL and no token.
    expect(workspace.commands.join("\n")).not.toMatch(/slack\.com|xox/);
    expect(storage.objects.size).toBe(0);
    const [row] = await db
      .db()
      .select({
        sha256: juniorAttachments.sha256,
        storageKey: juniorAttachments.storageKey,
      })
      .from(juniorAttachments)
      .where(eq(juniorAttachments.id, stored.id));
    expect(row).toEqual({ sha256: null, storageKey: null });
  });

  it("refuses a Slack file over the file limit before it downloads it", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const stored = await recordLargeSlackFile({
      db,
      fileId: "F0GREW",
      storage,
    });
    // The file was replaced in Slack after ingest and is now over the limit.
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0GREW",
        size: MAX_ATTACHMENT_BYTES + 1,
        urlPrivate: "https://files.slack.com/files-pri/T0TEST-F0GREW/x.mp4",
      }),
    });
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      readAttachmentSource: readSlackAttachmentSource,
      storage,
      workspace,
    });

    await expect(
      tool.execute?.({ attachment_id: stored.id }, {}),
    ).rejects.toThrow(new ToolInputError(ATTACHMENT_TOO_LARGE_MESSAGE));
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
    expect(workspace.writes).toEqual([]);
  });

  it("reports a deleted Slack file as a tool error", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const stored = await recordLargeSlackFile({
      db,
      fileId: "F0GONE",
      storage,
    });
    const workspace = localWorkspace(root);
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      readAttachmentSource: readSlackAttachmentSource,
      storage,
      workspace,
    });
    // Slack reports the file gone, or still lists it but refuses the download.
    queueSlackApiError("files.info", { error: "file_not_found" });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0GONE",
        size: 20 * MIB,
        urlPrivate: "https://files.slack.com/files-pri/T0TEST-F0GONE/x.mp4",
      }),
    });
    queueSlackPrivateFileDownload({ status: 404, body: "" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        tool.execute?.({ attachment_id: stored.id }, {}),
      ).rejects.toThrow(
        new ToolInputError(
          "standup.mp4 is no longer available: The Slack file was deleted, or Junior can no longer access it.",
        ),
      );
    }
    expect(getCapturedSlackFileDownloadCalls()).toHaveLength(1);
    expect(workspace.writes).toEqual([]);
    expect(
      await fs.readdir(path.join(root, ".junior/attachments"), {
        recursive: true,
      }),
    ).toEqual([stored.id]);
  });

  it("starts a Slack download only from a row in this conversation", async () => {
    const storage = createMemoryAttachmentStorage();
    const db = getSqlExecutor();
    await recordConversation();
    const otherConversationId = "slack:C-load-attachment:other";
    await getConversationStore().recordActivity({
      conversationId: otherConversationId,
      destination: { channelId: "CLOAD", platform: "slack", teamId: "TLOAD" },
      nowMs: 1,
      source: "slack",
      title: "Other conversation",
      visibility: "public",
    });
    const elsewhere = await recordLargeSlackFile({
      conversationId: otherConversationId,
      db,
      fileId: "F0ELSEWHERE",
      storage,
    });
    const tool = createLoadAttachmentTool({
      conversationId: CONVERSATION_ID,
      db,
      readAttachmentSource: readSlackAttachmentSource,
      storage,
      workspace: localWorkspace(root),
    });

    // A row id from another conversation, a raw Slack file id, and an
    // unknown id all miss the conversation-scoped lookup.
    for (const attachmentId of [elsewhere.id, "F0ELSEWHERE", "att_unknown"]) {
      await expect(
        tool.execute?.({ attachment_id: attachmentId }, {}),
      ).rejects.toThrow(
        new ToolInputError("Attachment not found in this conversation."),
      );
    }
    expect(getCapturedSlackApiCalls("files.info")).toEqual([]);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
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
