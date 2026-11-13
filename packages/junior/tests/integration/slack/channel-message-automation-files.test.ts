import { createAutomationTool } from "@/chat/automations/tools/create";
import { automationToolContext } from "@/chat/automations/tool-access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { loadProjection } from "@/chat/conversations/projection";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createTools, type ToolRuntimeContext } from "@/chat/tools";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { collectAttachments } from "@/chat/providers/slack/input";
import { toConversationMessage } from "@/chat/runtime/conversation-message";
import { createSlackDispatchTurnRunner } from "@/chat/slack/dispatch-turn";
import { getLocationConfigurationService } from "@/chat/runtime/thread-state";
import type { Message } from "chat";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { juniorAutomations } from "@/db/schema/automations";
import { context, execute } from "../../fixtures/event-automations";
import {
  channelMessageTrigger,
  postChannelMessage,
} from "../../fixtures/slack-channel-messages";
import {
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  SLACK_BOT_USER_ID,
  type ConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";
import { conversationsRepliesPage } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileDownloadUrls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "channel-message-automation-test-secret";
});

// Slack webhook fixtures post from workspace T123 in channel C123.
const TEAM_ID = "T123";

let fixture: LocalJuniorSqlFixture;
let queue: ConversationWorkQueueTestAdapter;

// Start a dispatch run through the Slack runner and return its input message.
// The Turn itself, with the agent, does not run.
async function startDispatchRun(dispatchId: string): Promise<Message> {
  const dispatch = await getDispatchRecord(dispatchId);
  let input: Message | undefined;
  await createSlackDispatchTurnRunner({
    getLocationConfiguration: getLocationConfigurationService,
    getSlackAdapter: () => createSlackAdapterFixture(),
    executeSlackTurn: async (_thread, message) => {
      input = message;
    },
  })(dispatch!, { ack: async () => {} });
  return input!;
}

function conversationApi(storage: AttachmentStorage): Hono<JuniorApiEnv> {
  return new Hono<JuniorApiEnv>().route(
    "/api/conversations",
    createConversationRoutes({ attachmentStorage: storage, queue }),
  );
}

describe("Slack channel-message automation files", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    queue = createConversationWorkQueueTestAdapter();
    // The automation tools save cards to the creation Conversation.
    await getConversationStore().recordActivity({
      conversationId: "test:event-annotations",
      destination: {
        platform: "local",
        conversationId: "test:event-annotations",
      },
      source: "local",
      nowMs: Date.now(),
    });
  });

  afterEach(async () => {
    await fixture.sql
      .db()
      .delete(juniorAutomations)
      .where(eq(juniorAutomations.teamId, TEAM_ID));
    await fixture.close();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("stores the triggering post's files when the run starts and opens other thread files by id", async () => {
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    await execute(
      createAutomationTool(
        automationToolContext(channelContext),
        getEventCatalog(),
      ),
      {
        instruction: "Answer questions about charts.",
        title: "Triage charts",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: channelMessageTrigger(),
      },
    );
    const rootTs = "1712350.0001";
    const slackFile = (id: string, name: string) => ({
      id,
      name,
      mimetype: "image/png",
      url_private: `https://files.slack.com/files-pri/${TEAM_ID}-${id}/${name}`,
    });
    const rootFile = slackFile("F0ROOTPNG1", "chart.png");
    const forwardedFile = slackFile("F0FWDPNG1", "forwarded.png");
    const replyFile = slackFile("F0REPLYPNG1", "reply.png");

    // The post has its own file and forwards a message with a file. The
    // dispatch record names the post, not its files.
    const rootMessage = {
      attachments: [{ fallback: "forwarded", files: [forwardedFile] }],
      files: [rootFile],
      text: "Why did this chart drop?",
      ts: rootTs,
    };
    await postChannelMessage(queue, rootMessage);
    const runConversationId = queue.sentRecords()[0]!.conversationId;
    const dispatchId = runConversationId.replace(/^agent-dispatch:/, "");
    const dispatch = await getDispatchRecord(dispatchId);
    expect(dispatch?.metadata).toMatchObject({ slackMessageTs: rootTs });
    expect(JSON.stringify(dispatch)).not.toContain(rootFile.id);

    // When the run starts, it reads the post from Slack. Its input message
    // stores both files under their Slack file ids, gives them to the model,
    // and lists them.
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: rootTs,
        messages: [{ ...rootMessage, user: "U123" }],
      }),
    });
    const input = await startDispatchRun(dispatchId);
    expect(
      getCapturedSlackApiCalls("conversations.replies").map(
        (call) => call.params,
      ),
    ).toEqual([
      expect.objectContaining({
        channel: "C123",
        inclusive: "true",
        latest: rootTs,
        oldest: rootTs,
        ts: rootTs,
      }),
    ]);
    const attachmentStorage = createMemoryAttachmentStorage();
    queueSlackPrivateFileDownload({ body: "root-chart" });
    queueSlackPrivateFileDownload({ body: "forwarded" });
    const modelFiles = await createJuniorRuntimeServices({
      visionContext: { attachmentStorage },
    }).visionContext.resolveUserAttachments(collectAttachments(input), {
      conversationId: runConversationId,
    });
    expect(modelFiles.map((file) => file.filename)).toEqual([
      "chart.png",
      "forwarded.png",
    ]);
    const inputMessage = toConversationMessage({
      entry: input,
      text: dispatch!.input,
    });
    expect(inputMessage.meta?.slackFileIds).toEqual([
      rootFile.id,
      forwardedFile.id,
    ]);
    expect(dispatch?.destinationVisibility).toBe("public");
    await getConversationStore().recordActivity({
      conversationId: runConversationId,
      destination: dispatch!.destination,
      nowMs: Date.now(),
      source: "slack",
      visibility: dispatch!.destinationVisibility,
    });
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(inputMessage);
    await persistConversationMessages({
      conversation,
      conversationId: runConversationId,
    });

    // The Conversation page shows the files on that message.
    const page = await (
      await conversationApi(attachmentStorage).request(
        `http://localhost/api/conversations/${encodeURIComponent(runConversationId)}`,
      )
    ).json();
    expect(
      page.events.find(
        (event: { data: { messageId?: string } }) =>
          event.data.messageId === inputMessage.id,
      )?.data.attachments,
    ).toEqual([
      expect.objectContaining({ filename: "chart.png", bytes: 10 }),
      expect.objectContaining({ filename: "forwarded.png", bytes: 9 }),
    ]);

    // A person's mention in the thread joins the run's Conversation.
    await postChannelMessage(queue, {
      text: `<@${SLACK_BOT_USER_ID}> can you look at the chart?`,
      threadTs: rootTs,
      ts: "1712350.0002",
    });
    expect(
      queue.sentRecords().map((record) => record.conversationId),
    ).not.toContain(`slack:C123:${rootTs}`);
    const stored = await getConversationStore().get({
      conversationId: runConversationId,
    });
    expect(stored?.location).toMatchObject({
      channelId: "C123",
      threadTs: rootTs,
    });

    const written: string[] = [];
    const workspace: SandboxWorkspace = {
      readFileToBuffer: async () => null,
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      writeFiles: async (files) => {
        written.push(...files.map((file) => file.content.toString()));
      },
    };
    const { loadAttachment } = createTools([], {}, {
      ...context("U123", "C123", "public", rootTs, TEAM_ID),
      attachmentStorage,
      conversationId: runConversationId,
      location: stored?.location,
      workspace,
    } as ToolRuntimeContext);
    const threadReplies = () =>
      queueSlackApiResponse("conversations.replies", {
        body: conversationsRepliesPage({
          threadTs: rootTs,
          messages: [
            { ts: rootTs, user: "U123", files: [rootFile] },
            {
              ts: "1712350.0003",
              thread_ts: rootTs,
              user: "U123",
              attachments: [
                {
                  files: [
                    replyFile,
                    {
                      ...slackFile("F0APIURL1", "api.png"),
                      url_private: "https://slack.com/api/auth.test",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
    const repliesCalls = getCapturedSlackApiCalls(
      "conversations.replies",
    ).length;

    // The root file opens by its Slack file id from the stored copy.
    await expect(
      execute(loadAttachment!, { attachment_id: rootFile.id }, "call-root"),
    ).resolves.toMatchObject({ filename: "chart.png", bytes: 10 });
    expect(written).toEqual(["root-chart"]);

    // A file of a message that started no Turn is found in the thread and
    // stored once.
    threadReplies();
    queueSlackPrivateFileDownload({ body: "reply" });
    await expect(
      execute(loadAttachment!, { attachment_id: replyFile.id }, "call-reply"),
    ).resolves.toMatchObject({ filename: "reply.png", bytes: 5 });
    // A retry of the same tool call writes the file again but adds no
    // second transcript item.
    await execute(
      loadAttachment!,
      { attachment_id: replyFile.id },
      "call-reply",
    );
    expect(written).toEqual(["root-chart", "reply", "reply"]);
    expect(
      getCapturedSlackApiCalls("conversations.replies")
        .slice(repliesCalls)
        .map((call) => call.params),
    ).toEqual([expect.objectContaining({ channel: "C123", ts: rootTs })]);
    expect(getCapturedSlackFileDownloadUrls()).toEqual([
      rootFile.url_private,
      forwardedFile.url_private,
      replyFile.url_private,
    ]);

    // A file that is not in the run's thread, or whose URL is not on Slack's
    // file host, is refused and not downloaded.
    for (const fileId of ["F0OTHERPNG", "F0APIURL1"]) {
      threadReplies();
      await expect(
        execute(loadAttachment!, { attachment_id: fileId }),
      ).rejects.toThrow("not in this conversation's thread");
    }
    expect(getCapturedSlackFileDownloadUrls()).toHaveLength(3);
    expect(getCapturedSlackApiCalls("auth.test")).toEqual([]);

    // Each tool call that read a file shows it once in the transcript, as
    // Junior's file media. Refused calls show nothing.
    const readPage = await (
      await conversationApi(attachmentStorage).request(
        `http://localhost/api/conversations/${encodeURIComponent(runConversationId)}`,
      )
    ).json();
    expect(
      readPage.events
        .filter(
          (event: { data: { type: string } }) =>
            event.data.type === "attachments_delivered",
        )
        .map((event: { data: { attachments: Array<{ filename: string }> } }) =>
          event.data.attachments.map((file) => file.filename),
        ),
    ).toEqual([["chart.png"], ["reply.png"]]);
    const history =
      await getConversationEventStore().loadHistory(runConversationId);
    expect(
      history
        .filter((event) => event.data.type === "attachments_delivered")
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({ toolCallId: "call-root" }),
      expect.objectContaining({ toolCallId: "call-reply" }),
    ]);
    // The model's history does not include them.
    expect(
      JSON.stringify(
        await loadProjection({ conversationId: runConversationId }),
      ),
    ).not.toContain("reply.png");

    // A Conversation without a Slack thread still opens a file it stored,
    // by its Slack file id, without reading Slack.
    const { loadAttachment: loadWithoutThread } = createTools([], {}, {
      ...context("U123", "C123", "public", undefined, TEAM_ID),
      attachmentStorage,
      conversationId: runConversationId,
      location: { ...stored?.location, threadTs: undefined },
      workspace,
    } as ToolRuntimeContext);
    const repliesBefore = getCapturedSlackApiCalls(
      "conversations.replies",
    ).length;
    await expect(
      execute(loadWithoutThread!, { attachment_id: rootFile.id }),
    ).resolves.toMatchObject({ filename: "chart.png", bytes: 10 });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(
      repliesBefore,
    );
  });

  it("starts the run with its text when Slack cannot return the triggering post", async () => {
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    await execute(
      createAutomationTool(
        automationToolContext(channelContext),
        getEventCatalog(),
      ),
      {
        instruction: "Answer questions about charts.",
        title: "Triage charts",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: channelMessageTrigger(),
      },
    );
    await postChannelMessage(queue, {
      text: "Why did this chart drop?",
      ts: "1712351.0001",
    });
    const dispatchId = queue
      .sentRecords()[0]!
      .conversationId.replace(/^agent-dispatch:/, "");
    queueSlackApiError("conversations.replies", { error: "channel_not_found" });

    const input = await startDispatchRun(dispatchId);
    expect(input.text).toContain("Why did this chart drop?");
    expect(input.attachments).toEqual([]);
    expect(getCapturedSlackFileDownloadUrls()).toEqual([]);
  });
});
