import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { createSlackThreadReadTool } from "@/chat/slack/tools/thread-read";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import {
  conversationsInfoOk,
  conversationsJoinOk,
  conversationsRepliesPage,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../msw/handlers/slack-api";
import { mswServer } from "../msw/server";

type ContextOverrides = Omit<
  Partial<SlackToolContext>,
  "destinationChannelId" | "locationChannelId" | "teamId"
> & {
  destinationChannelId?: string;
  locationChannelId?: string;
  teamId?: string;
};

function requireSlackChannelId(value: string) {
  const channelId = parseSlackChannelId(value);
  if (!channelId) {
    throw new Error(`Invalid test Slack channel ID: ${value}`);
  }
  return channelId;
}

function requireSlackTeamId(value: string) {
  const teamId = parseSlackTeamId(value);
  if (!teamId) {
    throw new Error(`Invalid test Slack team ID: ${value}`);
  }
  return teamId;
}

function createContext(overrides: ContextOverrides = {}): SlackToolContext {
  const locationChannelId = requireSlackChannelId(
    overrides.locationChannelId ?? "C0CURRENT",
  );
  const destinationChannelId =
    overrides.destinationChannelId !== undefined
      ? requireSlackChannelId(overrides.destinationChannelId)
      : locationChannelId;
  const teamId = requireSlackTeamId(overrides.teamId ?? "T123");
  const {
    locationChannelId: _locationChannelId,
    destinationChannelId: _destinationChannelId,
    teamId: _teamId,
    ...rest
  } = overrides;
  return {
    destinationChannelId,
    locationChannelId,
    teamId,
    ...rest,
  };
}

function createTool(overrides: ContextOverrides = {}) {
  return createSlackThreadReadTool(createContext(overrides));
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slackThreadRead", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("reads a thread from a public channel URL", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.123456",
        messages: [
          {
            ts: "1700000000.123456",
            thread_ts: "1700000000.123456",
            user: "U1",
            text: "root message",
          },
          {
            ts: "1700000000.200000",
            thread_ts: "1700000000.123456",
            user: "U2",
            text: "reply message",
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C0AHB7N2JCR/p1700000000123456",
    });

    expect(result).toMatchObject({
      channel_id: "C0AHB7N2JCR",
      target_message_ts: "1700000000.123456",
      thread_ts: "1700000000.123456",
      count: 2,
    });
    expect(result).not.toHaveProperty("conversation_ids");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      slack_ts: "1700000000.123456",
      text: "root message",
    });
    expect(result.messages[1].text).toBe("reply message");

    // Live channel metadata may be fetched even when persisted public visibility exists.
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("returns Conversation ids for the thread", async () => {
    const store = getConversationStore();
    const nowMs = Date.parse("2026-07-01T12:00:00.000Z");
    for (const conversationId of [
      "automation-run:1",
      "slack:C0AHB7N2JCR:1700000000.123456",
    ]) {
      await store.recordActivity({
        conversationId,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C0AHB7N2JCR",
        },
        nowMs,
        source: "slack",
      });
    }
    await store.bindProviderConversation({
      conversationId: "automation-run:1",
      provider: "slack",
      providerDestinationId: "C0AHB7N2JCR",
      providerTenantId: "T123",
      providerConversationId: "1700000000.123456",
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.123456",
        messages: [
          {
            ts: "1700000000.123456",
            thread_ts: "1700000000.123456",
            user: "U1",
            text: "root message",
          },
        ],
      }),
    });

    const result = await executeTool(createTool({}), {
      url: "https://sentry.slack.com/archives/C0AHB7N2JCR/p1700000000123456",
    });

    expect(result.conversation_ids).toEqual([
      "automation-run:1",
      "slack:C0AHB7N2JCR:1700000000.123456",
    ]);
  });

  it("uses thread_ts from the URL when present", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.000000",
        messages: [
          {
            ts: "1700000000.000000",
            thread_ts: "1700000000.000000",
            user: "U1",
            text: "thread root",
          },
          {
            ts: "1700000000.999999",
            thread_ts: "1700000000.000000",
            user: "U2",
            text: "the linked reply",
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000999999?thread_ts=1700000000.000000&cid=C123",
    });

    expect(result).toMatchObject({
      channel_id: "C123",
      target_message_ts: "1700000000.999999",
      thread_ts: "1700000000.000000",
      count: 2,
    });

    expect(
      getCapturedSlackApiCalls("conversations.replies")[0]?.params,
    ).toMatchObject({
      channel: "C123",
      ts: "1700000000.000000",
    });
  });

  it("reads a thread from explicit channel_id and slack_ts", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.500000",
        messages: [
          {
            ts: "1700000000.500000",
            thread_ts: "1700000000.500000",
            user: "U1",
            text: "standalone message",
            subtype: "bot_message",
            reactions: [
              {
                name: "raised_hands",
                count: 2,
                users: ["U2", "U3"],
              },
            ],
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0MANUAL",
      slack_ts: "1700000000.500000",
      url: null,
      limit: null,
      max_pages: null,
    });

    expect(result).toMatchObject({
      channel_id: "C0MANUAL",
      count: 1,
      messages: [
        {
          text: "standalone message",
          subtype: "bot_message",
          reactions: [
            {
              name: "raised_hands",
              count: 2,
              users: ["U2", "U3"],
            },
          ],
        },
      ],
    });
  });

  it("allows reading a private channel when it matches the current channel", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "private but same channel",
          },
        ],
      }),
    });

    const tool = createTool({ locationChannelId: "G0PRIVATE" });
    const result = await executeTool(tool, {
      channel_id: "G0PRIVATE",
      slack_ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      channel_id: "G0PRIVATE",
      count: 1,
    });

    // No extra API call for same-channel private reads
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("reads a private group channel from assistant context during DM turns", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "private context root",
          },
        ],
      }),
    });

    const tool = createTool({
      locationChannelId: "D0DM",
      destinationChannelId: "G0PRIVATE",
    });
    const result = await executeTool(tool, {
      channel_id: "G0PRIVATE",
      slack_ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      channel_id: "G0PRIVATE",
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("blocks reading a private group channel from a DM conversation without assistant context", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "G0PRIVATE",
        isPrivate: true,
        isGroup: true,
      }),
    });
    const tool = createTool({ locationChannelId: "D0DM" });
    await expect(
      executeTool(tool, {
        channel_id: "G0PRIVATE",
        slack_ts: "1700000000.100000",
      }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a private channel that is not the current channel", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "G0OTHER",
        isPrivate: true,
        isGroup: true,
      }),
    });
    const tool = createTool({ locationChannelId: "C0CURRENT" });
    await expect(
      executeTool(tool, {
        url: "https://sentry.slack.com/archives/G0OTHER/p1700000000100000",
      }),
    ).rejects.toThrow("private");

    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a DM channel that is not the current channel", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "D0SOMEONE",
        isIm: true,
      }),
    });
    const tool = createTool();
    await expect(
      executeTool(tool, {
        channel_id: "D0SOMEONE",
        slack_ts: "1700000000.100000",
      }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("allows reading a public channel proven by conversations.info", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0UNCONFIRMED",
        isPrivate: false,
      }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "public channel root",
          },
        ],
      }),
    });

    const tool = createTool({ locationChannelId: "C0CURRENT" });
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C0UNCONFIRMED/p1700000000100000",
    });

    expect(result).toMatchObject({
      channel_id: "C0UNCONFIRMED",
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("blocks reading a private channel reported by conversations.info", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0UNCONFIRMED",
        isPrivate: true,
      }),
    });

    const tool = createTool({ locationChannelId: "C0CURRENT" });
    await expect(
      executeTool(tool, {
        url: "https://sentry.slack.com/archives/C0UNCONFIRMED/p1700000000100000",
      }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("does not trust stale persisted public visibility when live Slack proof fails", async () => {
    await getConversationStore().recordActivity({
      conversationId: "slack:C0STALE:1700000000.100000",
      channelName: "was-public",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C0STALE",
      },
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
      source: "slack",
      visibility: "public",
    });
    queueSlackApiError("conversations.info", {
      error: "channel_not_found",
    });

    const tool = createTool({ locationChannelId: "C0CURRENT" });
    await expect(
      executeTool(tool, {
        url: "https://sentry.slack.com/archives/C0STALE/p1700000000100000",
      }),
    ).rejects.toThrow(/not found|cannot see it/i);
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("joins then retries when conversations.replies returns not_in_channel", async () => {
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0FLAKY" }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "after join",
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0FLAKY",
      slack_ts: "1700000000.100000",
    });
    expect(result).toMatchObject({
      channel_id: "C0FLAKY",
      joined_channel: true,
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.join")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(2);
  });

  it("returns a recoverable error when replies still fail after join", async () => {
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0STILL" }),
    });
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });

    const tool = createTool({});
    await expect(
      executeTool(tool, {
        channel_id: "C0STILL",
        slack_ts: "1700000000.100000",
      }),
    ).rejects.toThrow("Could not read this Slack thread");
  });

  it("returns an error for invalid URL input", async () => {
    const tool = createTool();
    await expect(executeTool(tool, { url: "not a valid url" })).rejects.toThrow(
      "Input is not a valid URL",
    );
  });

  it("returns an error when neither url nor channel_id+ts are provided", async () => {
    const tool = createTool();
    await expect(executeTool(tool, {})).rejects.toThrow("Provide either");
  });

  it("rejects invalid explicit slack_ts format", async () => {
    const tool = createTool();
    await expect(
      executeTool(tool, {
        channel_id: "C123",
        slack_ts: "not-a-timestamp",
      }),
    ).rejects.toThrow("Invalid `slack_ts` Slack timestamp");
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("paginates across multiple reply pages", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.000000",
        messages: [
          {
            ts: "1700000000.000000",
            thread_ts: "1700000000.000000",
            user: "U1",
            text: "root",
          },
          {
            ts: "1700000000.001000",
            thread_ts: "1700000000.000000",
            user: "U2",
            text: "reply-1",
          },
        ],
        nextCursor: "page-2-cursor",
      }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.000000",
        messages: [
          {
            ts: "1700000000.002000",
            thread_ts: "1700000000.000000",
            user: "U3",
            text: "reply-2",
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0PAGED",
      slack_ts: "1700000000.000000",
    });

    expect(result).toMatchObject({
      count: 3,
    });
    expect(result.messages).toHaveLength(3);

    const calls = getCapturedSlackApiCalls("conversations.replies");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({
      cursor: "page-2-cursor",
    });
  });

  it("strips private file URLs from returned messages", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "message with file",
            files: [
              {
                id: "F123",
                name: "secret.pdf",
                mimetype: "application/pdf",
                size: 12345,
                url_private: "https://files.slack.com/secret-url",
                url_private_download: "https://files.slack.com/secret-dl",
              },
            ],
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C123",
      slack_ts: "1700000000.100000",
    });

    const file = result.messages[0].files[0];
    expect(file).toEqual({
      id: "F123",
      name: "secret.pdf",
      mimetype: "application/pdf",
      size: 12345,
    });
    expect(file).not.toHaveProperty("url_private");
    expect(file).not.toHaveProperty("url_private_download");
  });

  it("surfaces files nested inside a forwarded/shared message's attachments", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.300000",
        messages: [
          {
            ts: "1700000000.300000",
            thread_ts: "1700000000.300000",
            user: "U1",
            text: "Billing issue. can you diagnose",
            attachments: [
              {
                is_share: true,
                author_name: "David Cramer",
                text: "Billing issue.",
                files: [
                  {
                    id: "F_SHARED_1",
                    name: "billing.png",
                    mimetype: "image/png",
                    size: 111,
                    url_private: "https://files.slack.com/shared-1",
                    url_private_download: "https://files.slack.com/shared-1-dl",
                  },
                  {
                    id: "F_SHARED_2",
                    name: "payment-form.png",
                    mimetype: "image/png",
                    size: 222,
                  },
                ],
              },
            ],
          } as any,
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0SHARE",
      slack_ts: "1700000000.300000",
    });

    expect(result.messages[0].files).toEqual([
      {
        id: "F_SHARED_1",
        name: "billing.png",
        mimetype: "image/png",
        size: 111,
      },
      {
        id: "F_SHARED_2",
        name: "payment-form.png",
        mimetype: "image/png",
        size: 222,
      },
    ]);
    expect(result.messages[0].files[0]).not.toHaveProperty("url_private");
  });

  it("does not call conversations.history — only conversations.replies", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "msg",
          },
        ],
      }),
    });

    const tool = createTool({});
    await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000100000",
    });

    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  describe("files in the current Conversation's thread", () => {
    const CONVERSATION_ID = "slack:C0CURRENT:1700000000.500000";
    const THREAD_TS = "1700000000.500000";

    async function setup() {
      await getConversationStore().recordActivity({
        conversationId: CONVERSATION_ID,
        destination: {
          channelId: "C0CURRENT",
          platform: "slack",
          teamId: "T123",
        },
        nowMs: 1,
        source: "slack",
        title: "Thread file conversation",
        visibility: "public",
      });
      const storage = createMemoryAttachmentStorage();
      const db = getSqlExecutor();
      const tool = createSlackThreadReadTool(
        createContext({ threadTs: parseSlackMessageTs(THREAD_TS) }),
        { conversationId: CONVERSATION_ID, db, storage },
      );
      return { db, storage, tool };
    }

    function queueThread(messages: unknown[], threadTs = THREAD_TS) {
      queueSlackApiResponse("conversations.replies", {
        body: conversationsRepliesPage({ threadTs, messages: messages as any }),
      });
    }

    it("stores linked files that no Turn stored and returns attachment ids that loadAttachment reads", async () => {
      const { db, storage, tool } = await setup();
      queueThread([
        {
          ts: THREAD_TS,
          thread_ts: THREAD_TS,
          user: "U1",
          text: "here's the csv",
          files: [
            {
              id: "F0CSV0001",
              name: "reasons.csv",
              mimetype: "text/csv",
              size: 9,
              url_private:
                "https://files.slack.com/files-pri/T123-F0CSV0001/reasons.csv",
            },
          ],
        },
        {
          ts: "1700000000.600000",
          thread_ts: THREAD_TS,
          user: "U1",
          text: "here's the pdf <https://sentry.slack.com/archives/C0OTHER/p1>",
          attachments: [
            {
              is_share: true,
              text: "Battlecard",
              files: [
                {
                  id: "F0PDF0001",
                  name: "battlecard.pdf",
                  mimetype: "application/pdf",
                  size: 8,
                  url_private:
                    "https://files.slack.com/files-pri/T123-F0PDF0001/battlecard.pdf",
                },
              ],
            },
          ],
        },
      ]);
      queueSlackPrivateFileDownload({ status: 200, body: "a,b\n1,2\n" });
      queueSlackPrivateFileDownload({ status: 200, body: "%PDF-1.4" });

      const result = await executeTool(tool, {
        channel_id: "C0CURRENT",
        slack_ts: THREAD_TS,
      });

      const csvId = result.messages[0].files[0].attachment_id;
      const pdfId = result.messages[1].files[0].attachment_id;
      expect(csvId).toEqual(expect.any(String));
      expect(pdfId).toEqual(expect.any(String));

      const written: Array<{ content: Buffer; path: string }> = [];
      const workspace: SandboxWorkspace = {
        readFileToBuffer: vi.fn(async () => null),
        runCommand: vi.fn(async () => ({
          exitCode: 0,
          stderr: "",
          stdout: "",
        })),
        writeFiles: vi.fn(async (files) => {
          written.push(...files);
        }),
      };
      const loadAttachment = createLoadAttachmentTool({
        conversationId: CONVERSATION_ID,
        db,
        storage,
        workspace,
      });
      await loadAttachment.execute?.({ attachment_id: csvId }, {});
      await loadAttachment.execute?.({ attachment_id: pdfId }, {});
      expect(written.map((file) => file.content.toString())).toEqual([
        "a,b\n1,2\n",
        "%PDF-1.4",
      ]);

      // A second read reuses the stored rows instead of downloading again.
      queueThread([
        {
          ts: THREAD_TS,
          thread_ts: THREAD_TS,
          user: "U1",
          text: "here's the csv",
          files: [
            {
              id: "F0CSV0001",
              name: "reasons.csv",
              mimetype: "text/csv",
              size: 9,
              url_private:
                "https://files.slack.com/files-pri/T123-F0CSV0001/reasons.csv",
            },
          ],
        },
      ]);
      const again = await executeTool(tool, {
        channel_id: "C0CURRENT",
        slack_ts: THREAD_TS,
      });
      expect(again.messages[0].files[0].attachment_id).toBe(csvId);
    });

    it("returns the attachment id a Turn already stored without downloading", async () => {
      const { db, storage, tool } = await setup();
      const stored = await storeAttachment({
        conversationId: CONVERSATION_ID,
        db,
        file: {
          bytes: 5,
          data: Buffer.from("hello"),
          filename: "notes.txt",
          mimeType: "text/plain",
          path: "notes.txt",
        },
        source: { id: "F0TXT0001", provider: "slack" },
        storage,
      });
      queueThread([
        {
          ts: THREAD_TS,
          thread_ts: THREAD_TS,
          user: "U1",
          text: "notes",
          files: [
            {
              id: "F0TXT0001",
              name: "notes.txt",
              mimetype: "text/plain",
              url_private:
                "https://files.slack.com/files-pri/T123-F0TXT0001/notes.txt",
            },
          ],
        },
      ]);
      // A download here would store different bytes under a new id.
      queueSlackPrivateFileDownload({ status: 200, body: "other" });

      const result = await executeTool(tool, {
        channel_id: "C0CURRENT",
        slack_ts: THREAD_TS,
      });

      expect(result.messages[0].files[0].attachment_id).toBe(stored.id);
    });

    it("keeps files metadata-only in other threads, for non-Slack URLs, and when a download fails", async () => {
      const { tool } = await setup();
      const file = (id: string, url: string) => ({
        id,
        name: `${id}.csv`,
        mimetype: "text/csv",
        url_private: url,
      });

      queueThread(
        [
          {
            ts: "1700000000.900000",
            thread_ts: "1700000000.900000",
            user: "U1",
            text: "another thread",
            files: [
              file(
                "F0OTHER01",
                "https://files.slack.com/files-pri/T123-F0OTHER01/x.csv",
              ),
            ],
          },
        ],
        "1700000000.900000",
      );
      const other = await executeTool(tool, {
        channel_id: "C0CURRENT",
        slack_ts: "1700000000.900000",
      });
      expect(other.messages[0].files[0]).not.toHaveProperty("attachment_id");

      queueThread([
        {
          ts: THREAD_TS,
          thread_ts: THREAD_TS,
          user: "U1",
          text: "files",
          attachments: [
            {
              files: [
                file("F0EVIL001", "https://evil.example.com/F0EVIL001.csv"),
              ],
            },
          ],
          files: [
            file(
              "F0FAIL001",
              "https://files.slack.com/files-pri/T123-F0FAIL001/x.csv",
            ),
          ],
        },
      ]);
      const offSlackRequests: string[] = [];
      mswServer.use(
        http.get("https://evil.example.com/:file", ({ request }) => {
          offSlackRequests.push(request.url);
          return new HttpResponse("stolen");
        }),
      );
      queueSlackPrivateFileDownload({ status: 403, body: "" });
      const current = await executeTool(tool, {
        channel_id: "C0CURRENT",
        slack_ts: THREAD_TS,
      });
      expect(current.messages[0].files).toEqual([
        expect.not.objectContaining({ attachment_id: expect.anything() }),
        expect.not.objectContaining({ attachment_id: expect.anything() }),
      ]);
      expect(offSlackRequests).toEqual([]);
    });
  });
});
