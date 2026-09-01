import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { createSendFilesTool } from "@/chat/slack/tools/send-files";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { readSandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { ToolState } from "@/chat/tools/types";
import { juniorAttachments } from "@/db/schema";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

function createToolState(): ToolState {
  const operationResultCache = new Map<string, unknown>();
  return {
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

type ContextOverrides = Omit<
  Partial<SlackToolContext>,
  | "destinationChannelId"
  | "messageTs"
  | "locationChannelId"
  | "teamId"
  | "threadTs"
> & {
  destinationChannelId?: string;
  messageTs?: string;
  locationChannelId?: string;
  teamId?: string;
  threadTs?: string;
};

function requireSlackChannelId(value: string) {
  const channelId = parseSlackChannelId(value);
  if (!channelId) throw new Error(`Invalid test Slack channel ID: ${value}`);
  return channelId;
}

function requireSlackTeamId(value: string) {
  const teamId = parseSlackTeamId(value);
  if (!teamId) throw new Error(`Invalid test Slack team ID: ${value}`);
  return teamId;
}

function requireSlackMessageTs(value: string) {
  const timestamp = parseSlackMessageTs(value);
  if (!timestamp) throw new Error(`Invalid test Slack timestamp: ${value}`);
  return timestamp;
}

function createContext(
  _userText: string,
  overrides: ContextOverrides = {},
): SlackToolContext {
  const locationChannelId = requireSlackChannelId(
    overrides.locationChannelId ?? "C123",
  );
  const destinationChannelId =
    overrides.destinationChannelId !== undefined
      ? requireSlackChannelId(overrides.destinationChannelId)
      : locationChannelId;
  const teamId = requireSlackTeamId(overrides.teamId ?? "T123");
  const {
    locationChannelId: _locationChannelId,
    destinationChannelId: _destinationChannelId,
    messageTs: overrideMessageTs,
    teamId: _teamId,
    threadTs: overrideThreadTs,
    ...rest
  } = overrides;
  const messageTs = requireSlackMessageTs(
    overrideMessageTs ?? "1700000000.321",
  );
  const threadTs = overrideThreadTs
    ? requireSlackMessageTs(overrideThreadTs)
    : undefined;
  return {
    destinationChannelId,
    messageTs,
    locationChannelId,
    teamId,
    ...(threadTs ? { threadTs } : undefined),
    ...rest,
  };
}

function createSandbox(files: Record<string, Buffer> = {}): SandboxWorkspace {
  return {
    readFileToBuffer: async ({ path }) => files[path] ?? null,
    runCommand: async () => ({
      exitCode: 0,
      stdout: "text/plain\n",
      stderr: "",
    }),
    writeFiles: async () => undefined,
  };
}

function createMaterializeFile(files: Record<string, Buffer> = {}) {
  const sandbox = createSandbox(files);
  return (input: { path: string; filename?: string; mimeType?: string }) =>
    readSandboxFileUpload(sandbox, input);
}

async function executeTool<TInput>(
  tool: any,
  input: TInput,
  options: { toolCallId?: string } = {},
) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, options as any);
}

describe("Slack sendFiles", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("sends file-only messages without posting empty text", async () => {
    const tool = createSendFilesTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toEqual({
      attachment_refs: [],
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.321",
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).not.toHaveProperty("initial_comment");
  });

  it("accepts a generated artifact reference without translating its path", async () => {
    const imageBytes = Buffer.from("image bytes");
    const generatedArtifact = {
      bytes: imageBytes.byteLength,
      filename: "generated.png",
      mimeType: "image/png",
      path: "/tmp/junior/artifacts/generated.png",
    };
    const tool = createSendFilesTool(
      createContext("share the generated image"),
      createToolState(),
      createMaterializeFile({ [generatedArtifact.path]: imageBytes }),
    );

    const result = await executeTool(tool, { files: [generatedArtifact] });

    expect(
      getCapturedSlackApiCalls("files.getUploadURLExternal")[0]?.params,
    ).toMatchObject({
      filename: generatedArtifact.filename,
      length: String(imageBytes.byteLength),
    });
    expect(result).toEqual({
      attachment_refs: [],
    });
  });

  it("uses the Conversation Location thread when Destination differs", async () => {
    const context = createContext("attach this here", {
      locationChannelId: "D123",
      destinationChannelId: "CSHARED",
      threadTs: "1700000000.321",
    });
    const tool = createSendFilesTool(
      context,
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toEqual({
      attachment_refs: [],
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "D123",
      thread_ts: "1700000000.321",
    });
  });

  it("uploads files to a channel-level Conversation Location", async () => {
    const context = createContext("attach the report");
    delete context.messageTs;
    const tool = createSendFilesTool(
      context,
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    const params = getCapturedSlackApiCalls("files.completeUploadExternal")[0]
      ?.params;
    expect(params).toMatchObject({ channel_id: "C123" });
    expect(params).not.toHaveProperty("thread_ts");
  });

  it("uploads files into the current Slack thread", async () => {
    const tool = createSendFilesTool(
      createContext("attach the report", {
        threadTs: "1700000000.321",
      }),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toEqual({
      attachment_refs: [],
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.321",
    });
  });

  it("treats nullable optional file metadata as omitted", async () => {
    const tool = createSendFilesTool(
      createContext("attach the report", {
        threadTs: "1700000000.321",
      }),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      files: [
        {
          path: "/tmp/report.txt",
          filename: null,
          mimeType: null,
          bytes: null,
        },
      ],
    });

    expect(result).toEqual({
      attachment_refs: [],
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.321",
    });
  });

  it("stores files and records delivered attachment transcript items", async () => {
    const conversationId = "conversation-1";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "C123",
        platform: "slack",
        teamId: "T123",
      },
      nowMs: Date.parse("2026-08-12T17:00:00.000Z"),
      source: "slack",
      title: "Attachment delivery conversation",
      visibility: "private",
    });
    const puts: string[] = [];
    const storage: AttachmentStorage = {
      provider: "test",
      get: async () => null,
      put: async (input) => {
        puts.push(input.key);
      },
      delete: async () => undefined,
    };
    const tool = createSendFilesTool(
      createContext("attach the report"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
      {
        conversationId,
        db: getSqlExecutor(),
        storage,
      },
    );

    const result = await executeTool(
      tool,
      {
        files: [{ path: "/tmp/report.txt" }],
      },
      { toolCallId: "call-send-1" },
    );
    // Clear in-process tool dedupe so a later call exercises durable reuse.
    const retryTool = createSendFilesTool(
      createContext("attach the report again"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
      {
        conversationId,
        db: getSqlExecutor(),
        storage,
      },
    );
    const retry = await executeTool(
      retryTool,
      {
        files: [{ path: "/tmp/report.txt" }],
      },
      { toolCallId: "call-send-2" },
    );

    const rows = await getSqlExecutor().db().select().from(juniorAttachments);
    expect(result.attachment_refs).toEqual([
      { id: rows[0]?.id, filename: "report.txt" },
    ]);
    expect(retry.attachment_refs).toEqual([
      { id: rows[0]?.id, filename: "report.txt" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId,
      filename: "report.txt",
      provider: "test",
    });
    expect(puts).toEqual([rows[0]?.storageKey]);
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(2);

    const history =
      await getConversationEventStore().loadHistory(conversationId);
    const delivered = history.filter(
      (event) => event.data.type === "attachments_delivered",
    );
    // One durable delivery item per successful store/send, including reuse.
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.data).toMatchObject({
      type: "attachments_delivered",
      toolCallId: "call-send-1",
      attachments: [
        {
          id: rows[0]?.id,
          filename: "report.txt",
          contentType: "text/plain",
          bytes: Buffer.byteLength("report body"),
        },
      ],
    });
    expect(delivered[1]?.data).toMatchObject({
      type: "attachments_delivered",
      toolCallId: "call-send-2",
    });
  });

  it("does not re-upload or mint a second delivery item on a cached retry", async () => {
    const conversationId = "conversation-cached-send";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "C123",
        platform: "slack",
        teamId: "T123",
      },
      nowMs: Date.parse("2026-08-12T17:00:00.000Z"),
      source: "slack",
      title: "Cached attachment delivery",
      visibility: "private",
    });
    const storage: AttachmentStorage = {
      provider: "test",
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    };
    const state = createToolState();
    const tool = createSendFilesTool(
      createContext("attach the report"),
      state,
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
      {
        conversationId,
        db: getSqlExecutor(),
        storage,
      },
    );

    const first = await executeTool(
      tool,
      { files: [{ path: "/tmp/report.txt" }] },
      { toolCallId: "call-send-cached" },
    );
    // A later tool call with the same bytes must reuse the original delivery
    // identity, not create another transcript row under a new toolCallId.
    const second = await executeTool(
      tool,
      { files: [{ path: "/tmp/report.txt" }] },
      { toolCallId: "call-send-later" },
    );

    expect(first.attachment_refs).toEqual([
      { id: expect.any(String), filename: "report.txt" },
    ]);
    expect(second).toMatchObject({
      deduplicated: true,
      attachment_refs: first.attachment_refs,
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(1);

    const history =
      await getConversationEventStore().loadHistory(conversationId);
    const delivered = history.filter(
      (event) => event.data.type === "attachments_delivered",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.data).toMatchObject({
      type: "attachments_delivered",
      toolCallId: "call-send-cached",
      attachments: [
        {
          id: first.attachment_refs[0]?.id,
          filename: "report.txt",
          contentType: "text/plain",
          bytes: Buffer.byteLength("report body"),
        },
      ],
    });
  });

  it("revives a purge-marked attachment on later store", async () => {
    const conversationId = "conversation-1";
    const now = new Date("2026-08-12T17:00:00.000Z");
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "C123",
        platform: "slack",
        teamId: "T123",
      },
      nowMs: now.getTime(),
      source: "slack",
      title: "Attachment revive conversation",
      visibility: "private",
    });
    const puts: string[] = [];
    const storage: AttachmentStorage = {
      provider: "test",
      get: async () => null,
      put: async (input) => {
        puts.push(input.key);
      },
      delete: async () => undefined,
    };
    const firstTool = createSendFilesTool(
      createContext("attach the report"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
      {
        conversationId,
        db: getSqlExecutor(),
        storage,
      },
    );
    const first = await executeTool(firstTool, {
      files: [{ path: "/tmp/report.txt" }],
    });
    const attachmentId = first.attachment_refs[0]?.id;
    expect(first.attachment_refs).toEqual([
      { id: expect.any(String), filename: "report.txt" },
    ]);

    await getSqlExecutor()
      .db()
      .update(juniorAttachments)
      .set({ deleteRequestedAt: now })
      .where(eq(juniorAttachments.id, attachmentId!));

    const retryTool = createSendFilesTool(
      createContext("attach the report again"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
      {
        conversationId,
        db: getSqlExecutor(),
        storage,
      },
    );
    const retry = await executeTool(retryTool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    const rows = await getSqlExecutor().db().select().from(juniorAttachments);
    expect(retry.attachment_refs).toEqual([
      { id: attachmentId, filename: "report.txt" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: attachmentId,
      deleteRequestedAt: null,
      storageKey: puts[1],
    });
    expect(puts).toHaveLength(2);
    expect(puts[0]).not.toBe(puts[1]);
  });

  it("deletes the blob when SQL insert fails after put", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      // No conversation row: FK on junior_attachments.conversation_id fails.
      const deleted: string[] = [];
      const puts: string[] = [];
      const storage: AttachmentStorage = {
        provider: "test",
        get: async () => null,
        put: async (input) => {
          puts.push(input.key);
        },
        delete: async (keys) => {
          deleted.push(...keys);
        },
      };
      const tool = createSendFilesTool(
        createContext("attach the report"),
        createToolState(),
        createMaterializeFile({
          "/tmp/report.txt": Buffer.from("report body"),
        }),
        {
          conversationId: "missing-conversation",
          db: fixture.sql,
          storage,
        },
      );

      await expect(
        executeTool(tool, {
          files: [{ path: "/tmp/report.txt" }],
        }),
      ).rejects.toThrow(/Failed query|foreign key|violates/i);

      expect(puts).toHaveLength(1);
      expect(deleted).toEqual(puts);
      expect(await fixture.sql.db().select().from(juniorAttachments)).toEqual(
        [],
      );
    } finally {
      await fixture.close();
    }
  });

  it("does not deduplicate changed file contents at the same path", async () => {
    const files = {
      "/tmp/report.txt": Buffer.from("first report"),
    };
    const tool = createSendFilesTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile(files),
    );

    await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });
    files["/tmp/report.txt"] = Buffer.from("updated report");
    await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(2);
  });

  it("deduplicates repeated uploads of the same file contents", async () => {
    const tool = createSendFilesTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });
    const second = await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(second).toMatchObject({
      deduplicated: true,
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(1);
  });

  it("reports a missing sendFiles path as repairable tool input", async () => {
    const tool = createSendFilesTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile(),
    );

    await expect(
      executeTool(tool, {
        files: [{ path: "/tmp/missing.txt" }],
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual(
      [],
    );
  });

  it("requires at least one file", async () => {
    const tool = createSendFilesTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile(),
    );

    expect(() => tool.prepareArguments?.({})).toThrow(/files/);
  });
});
