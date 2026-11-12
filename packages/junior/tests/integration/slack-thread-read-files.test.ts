import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { storeAttachment } from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { createSlackThreadReadTool } from "@/chat/slack/tools/thread-read";
import { createLoadAttachmentTool } from "@/chat/tools/load-attachment";
import { conversationsRepliesPage } from "../fixtures/slack/factories/api";
import {
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../msw/handlers/slack-api";
import { mswServer } from "../msw/server";

function createContext(threadTs: string) {
  const channelId = parseSlackChannelId("C0CURRENT");
  const teamId = parseSlackTeamId("T123");
  if (!channelId || !teamId) throw new Error("Invalid test Slack ids");
  return {
    destinationChannelId: channelId,
    locationChannelId: channelId,
    teamId,
    threadTs: parseSlackMessageTs(threadTs),
  };
}

async function executeTool<TInput>(tool: any, input: TInput) {
  return await tool.execute(input, {} as any);
}

afterEach(async () => {
  await closeDb();
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
    const tool = createSlackThreadReadTool(createContext(THREAD_TS), {
      conversationId: CONVERSATION_ID,
      db,
      storage,
    });
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

    // The model often sends only a timestamp from the current thread.
    const result = await executeTool(tool, { slack_ts: THREAD_TS });

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

    expect(result).not.toHaveProperty("unstored_file_count");

    // A second read reuses the stored rows instead of downloading again,
    // and stores at most 3 new files.
    const screenshotIds = ["F0IMG0001", "F0IMG0002", "F0IMG0003", "F0IMG0004"];
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
        ts: "1700000000.700000",
        thread_ts: THREAD_TS,
        user: "U1",
        text: "screenshots",
        files: screenshotIds.map((id) => ({
          id,
          name: `${id}.png`,
          mimetype: "image/png",
          url_private: `https://files.slack.com/files-pri/T123-${id}/${id}.png`,
        })),
      },
      {
        // The same file shared again uses no second cap slot.
        ts: "1700000000.800000",
        thread_ts: THREAD_TS,
        user: "U1",
        text: "this one again",
        files: [
          {
            id: "F0IMG0001",
            name: "F0IMG0001.png",
            mimetype: "image/png",
            url_private:
              "https://files.slack.com/files-pri/T123-F0IMG0001/F0IMG0001.png",
          },
        ],
      },
    ]);
    for (const id of screenshotIds.slice(0, 3)) {
      queueSlackPrivateFileDownload({ status: 200, body: id });
    }
    const again = await executeTool(tool, {
      channel_id: "C0CURRENT",
      slack_ts: THREAD_TS,
    });
    expect(again.messages[0].files[0].attachment_id).toBe(csvId);
    expect(
      again.messages[1].files.map(
        (file: { attachment_id?: string }) => file.attachment_id,
      ),
    ).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      undefined,
    ]);
    expect(again.messages[2].files[0].attachment_id).toBe(
      again.messages[1].files[0].attachment_id,
    );
    expect(again.unstored_file_count).toBe(1);
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

  it("keeps files metadata-only in other threads, for non-file URLs, and when a download fails", async () => {
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
        // Failed downloads use no cap slot, so the file after them is stored.
        files: [
          // A Slack Web API URL would run as the bot.
          file(
            "F0EVIL002",
            "https://slack.com/api/conversations.history?channel=C0SECRET",
          ),
          ...["F0FAIL001", "F0FAIL002", "F0FAIL003", "F0GOOD001"].map((id) =>
            file(id, `https://files.slack.com/files-pri/T123-${id}/x.csv`),
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
      http.get("https://slack.com/api/:method", ({ request }) => {
        offSlackRequests.push(request.url);
        return HttpResponse.json({ ok: true, messages: [] });
      }),
    );
    for (let i = 0; i < 3; i += 1) {
      queueSlackPrivateFileDownload({ status: 403, body: "" });
    }
    queueSlackPrivateFileDownload({ body: "a,b\n" });
    const current = await executeTool(tool, {
      channel_id: "C0CURRENT",
      slack_ts: THREAD_TS,
    });
    const noAttachment = expect.not.objectContaining({
      attachment_id: expect.anything(),
    });
    expect(current.messages[0].files).toEqual([
      noAttachment,
      noAttachment,
      noAttachment,
      noAttachment,
      expect.objectContaining({
        id: "F0GOOD001",
        attachment_id: expect.any(String),
      }),
      noAttachment,
    ]);
    expect(current).not.toHaveProperty("unstored_file_count");
    expect(offSlackRequests).toEqual([]);
  });
});
