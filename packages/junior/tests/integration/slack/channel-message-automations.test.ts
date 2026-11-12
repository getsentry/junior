import { createAutomationTool } from "@/chat/automations/tools/create";
import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import { automationToolContext } from "@/chat/automations/tool-access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { getConversationStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getEventAutomation } from "@/chat/event-automations/store";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createWatchEventsTool } from "@/chat/tools/watch-events";
import { createTools, type ToolRuntimeContext } from "@/chat/tools";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import { collectAttachments } from "@/chat/providers/slack/input";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { juniorAutomations } from "@/db/schema/automations";
import { context, execute } from "../../fixtures/event-automations";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
  type ConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";
import {
  botsInfoOk,
  conversationsRepliesPage,
  usersInfoOk,
} from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileDownloadUrls,
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

function trigger(match?: Record<string, string | string[]>) {
  return {
    type: "event" as const,
    namespace: "slack",
    label: "New messages in #discuss-integration",
    events: ["message.posted"],
    ...(match ? { match } : undefined),
  };
}

// Envelope fields of a channel that only workspace T123 can post in.
const WORKSPACE_CHANNEL = {
  context_enterprise_id: null,
  context_team_id: TEAM_ID,
  is_ext_shared_channel: false,
};

// Envelope fields of a channel in workspace T123 of Enterprise Grid org E123.
const ENTERPRISE_CHANNEL = {
  ...WORKSPACE_CHANNEL,
  context_enterprise_id: "E123",
  enterprise_id: "E123",
};

async function postChannelMessage(input: {
  blocks?: unknown[];
  botId?: string;
  botProfile?: Record<string, unknown>;
  channel?: string;
  envelope?: Record<string, unknown>;
  files?: Array<Record<string, unknown>>;
  /** Post as an app integration: a `bot_message` with a `bot_id` and no `user`. */
  noUser?: boolean;
  text?: string;
  threadTs?: string;
  ts: string;
  user?: string;
}) {
  const state = getStateAdapter();
  await state.connect();
  const slackAdapter = createSlackAdapterFixture();
  const {
    blocks,
    botId,
    botProfile,
    envelope: fields,
    files,
    noUser,
    ...message
  } = input;
  const envelope = slackEnvelope({
    eventType: "message",
    text: "How do I connect the Jira integration?",
    ...message,
  });
  if (botId) Object.assign(envelope.event, { bot_id: botId });
  if (blocks) Object.assign(envelope.event, { blocks });
  if (botProfile) Object.assign(envelope.event, { bot_profile: botProfile });
  if (files) Object.assign(envelope.event, { files });
  if (noUser) {
    Reflect.deleteProperty(envelope.event, "user");
    Object.assign(envelope.event, { subtype: "bot_message" });
  }
  if (fields) Object.assign(envelope, fields);
  return await handleSlackWebhookAndFlush({
    request: slackWebhookRequest(envelope),
    services: {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    },
  });
}

describe("Slack channel-message automations", () => {
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

  it("runs for new top-level messages in its own channel and replies in their threads", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    const { automation } = (await execute(
      createAutomationTool(automationToolContext(channelContext), catalog),
      {
        instruction:
          "Answer the question, or tag the Automation creator if you can't.",
        title: "Triage discuss-integration",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger(),
      },
    )) as { automation: { id: string } };

    // The trigger binds to the channel, and runs never get creator credentials.
    expect(
      await getEventAutomation(fixture.sql.db(), automation.id),
    ).toMatchObject({
      credentialMode: "system",
      trigger: { match: { channelId: "C123" }, namespace: "slack" },
    });

    // A thread reply, a bot post, and a message in another channel do not run it.
    expect(
      (
        await postChannelMessage({
          threadTs: "1712345.0001",
          ts: "1712345.0002",
        })
      ).status,
    ).toBe(200);
    expect(
      (await postChannelMessage({ botId: "B123", ts: "1712345.0005" })).status,
    ).toBe(200);
    expect(
      (await postChannelMessage({ channel: "C999", ts: "1712345.0003" }))
        .status,
    ).toBe(200);
    expect(queue.sentRecords()).toEqual([]);

    // A new top-level message runs it once, even when Slack delivers it twice.
    expect((await postChannelMessage({ ts: "1712345.0004" })).status).toBe(200);
    expect((await postChannelMessage({ ts: "1712345.0004" })).status).toBe(200);
    const sent = queue.sentRecords();
    expect(sent).toHaveLength(1);
    const dispatch = await getDispatchRecord(
      sent[0]!.conversationId.replace(/^agent-dispatch:/, ""),
    );
    expect(dispatch).toMatchObject({
      destination: { channelId: "C123", threadTs: "1712345.0004" },
      metadata: { eventAutomationId: automation.id },
      outcomes: [
        {
          action: "send_message",
          destination: { channelId: "C123", threadTs: "1712345.0004" },
        },
      ],
    });
    expect(dispatch?.credentialSubject).toBeUndefined();
    expect(dispatch?.input).toContain("How do I connect the Jira integration?");

    // A person's mention in the thread before the run replies joins the run.
    const runConversationId = sent[0]!.conversationId;
    await postChannelMessage({
      text: `<@${SLACK_BOT_USER_ID}> any update?`,
      threadTs: "1712345.0004",
      ts: "1712345.0006",
    });
    expect(
      queue.sentRecords().map((record) => record.conversationId),
    ).not.toContain("slack:C123:1712345.0004");
    const work = await getConversationWorkState({
      conversationId: runConversationId,
      state: getStateAdapter(),
    });
    expect(work?.execution.pendingMessages).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          text: expect.stringContaining("any update?"),
        }),
      }),
    );

    // Creator credentials cannot be turned on later.
    await execute(
      createUpdateAutomationTool(
        automationToolContext(channelContext),
        catalog,
      ),
      {
        automation_id: automation.id,
        credential_mode: "creator",
      },
    );
    expect(
      await getEventAutomation(fixture.sql.db(), automation.id),
    ).toMatchObject({ credentialMode: "system" });
  });

  it("opens files of the triggering post after a person mentions Junior in the run's thread", async () => {
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
        trigger: trigger(),
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

    // The run starts on a post with an image. The run's input is the post's
    // text, so no Turn stores the post's files.
    await postChannelMessage({
      files: [rootFile],
      text: "Why did this chart drop?",
      ts: rootTs,
    });
    const runConversationId = queue.sentRecords()[0]!.conversationId;

    // A person's mention in the thread joins the run's Conversation, so no
    // new Conversation reads the thread root and stores its files.
    await postChannelMessage({
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
    const attachmentStorage = createMemoryAttachmentStorage();
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
                    forwardedFile,
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

    // The root file and a file under a forwarded message open by their Slack
    // file ids.
    threadReplies();
    queueSlackPrivateFileDownload({ body: "root-chart" });
    await expect(
      execute(loadAttachment!, { attachment_id: rootFile.id }),
    ).resolves.toMatchObject({ filename: "chart.png", bytes: 10 });
    threadReplies();
    queueSlackPrivateFileDownload({ body: "forwarded" });
    await expect(
      execute(loadAttachment!, { attachment_id: forwardedFile.id }),
    ).resolves.toMatchObject({ filename: "forwarded.png", bytes: 9 });
    expect(written).toEqual(["root-chart", "forwarded"]);
    expect(
      getCapturedSlackApiCalls("conversations.replies")
        .slice(repliesCalls)
        .map((call) => call.params),
    ).toEqual([
      expect.objectContaining({ channel: "C123", ts: rootTs }),
      expect.objectContaining({ channel: "C123", ts: rootTs }),
    ]);

    // A stored file opens again without another Slack read or download.
    await execute(loadAttachment!, { attachment_id: rootFile.id });
    expect(written.at(-1)).toBe("root-chart");
    expect(getCapturedSlackFileDownloadUrls()).toEqual([
      rootFile.url_private,
      forwardedFile.url_private,
    ]);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(
      repliesCalls + 2,
    );

    // A Turn stores a file of a person's message under the Slack file id from
    // the Slack event, so it opens without a Slack read or another download.
    const notesFile = {
      ...slackFile("F0NOTESTXT", "notes.txt"),
      mimetype: "text/plain",
    };
    const notesMessage = createSlackAdapterFixture().parseMessage({
      type: "message",
      channel: "C123",
      files: [notesFile],
      team: TEAM_ID,
      text: "my notes",
      thread_ts: rootTs,
      ts: "1712350.0004",
      user: "U123",
    });
    queueSlackPrivateFileDownload({ body: "notes" });
    await createJuniorRuntimeServices({
      visionContext: { attachmentStorage },
    }).visionContext.resolveUserAttachments(collectAttachments(notesMessage), {
      conversationId: runConversationId,
    });
    await expect(
      execute(loadAttachment!, { attachment_id: notesFile.id }),
    ).resolves.toMatchObject({ filename: "notes.txt", bytes: 5 });
    expect(written.at(-1)).toBe("notes");
    expect(getCapturedSlackFileDownloadUrls()).toHaveLength(3);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(
      repliesCalls + 2,
    );

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
  });

  it("runs for bot posts only when its match names the bot", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    const { automation } = (await execute(
      createAutomationTool(automationToolContext(channelContext), catalog),
      {
        instruction: "Triage each new alert.",
        title: "Triage alerts",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger({ user_id: "U777" }),
      },
    )) as { automation: { id: string } };

    // A post from another bot does not run it.
    await postChannelMessage({
      botId: "B888",
      ts: "1712346.0001",
      user: "U888",
    });
    expect(queue.sentRecords()).toEqual([]);

    // A post from the named bot runs it and replies in the alert thread.
    await postChannelMessage({
      botId: "B777",
      ts: "1712346.0002",
      user: "U777",
    });
    const sent = queue.sentRecords();
    expect(sent).toHaveLength(1);
    const dispatch = await getDispatchRecord(
      sent[0]!.conversationId.replace(/^agent-dispatch:/, ""),
    );
    expect(dispatch).toMatchObject({
      destination: { channelId: "C123", threadTs: "1712346.0002" },
      metadata: { eventAutomationId: automation.id },
    });
  });

  it("runs for app integration posts that have no user only when its match names the bot ID", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    const { automation } = (await execute(
      createAutomationTool(automationToolContext(channelContext), catalog),
      {
        instruction: "Review each new report.",
        title: "Review reports",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger({ user_id: "B777" }),
      },
    )) as { automation: { id: string } };

    // Another bot, a channel shared with another organization, an envelope
    // without the workspace fields, another workspace or enterprise context,
    // an Enterprise Grid channel for a bot with no bot user, and a mention of
    // Junior in the text or in a section block run nothing.
    const rejected = [
      { botId: "B888", envelope: WORKSPACE_CHANNEL },
      {
        botId: "B777",
        envelope: { ...WORKSPACE_CHANNEL, is_ext_shared_channel: true },
      },
      { botId: "B777" },
      {
        botId: "B777",
        envelope: { ...WORKSPACE_CHANNEL, context_team_id: "T999" },
      },
      {
        botId: "B777",
        envelope: { ...ENTERPRISE_CHANNEL, enterprise_id: "E999" },
      },
      { botId: "B777", envelope: ENTERPRISE_CHANNEL },
      {
        botId: "B777",
        envelope: WORKSPACE_CHANNEL,
        text: `<@${SLACK_BOT_USER_ID}> summarize this`,
      },
      {
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `<@${SLACK_BOT_USER_ID}> summarize` },
          },
        ],
        botId: "B777",
        envelope: WORKSPACE_CHANNEL,
        text: "New report",
      },
    ];
    for (const [index, post] of rejected.entries()) {
      await postChannelMessage({
        ...post,
        noUser: true,
        ts: `1712348.000${index + 1}`,
      });
    }
    expect(queue.sentRecords()).toEqual([]);

    // A post from the named bot in a workspace-only channel runs it once and
    // replies in its thread, with system credentials. This bot has no bot
    // user, so bots.info is its only lookup.
    await postChannelMessage({
      botId: "B777",
      envelope: WORKSPACE_CHANNEL,
      noUser: true,
      ts: "1712348.0009",
    });
    const sent = queue.sentRecords();
    expect(sent).toHaveLength(1);
    const dispatch = await getDispatchRecord(
      sent[0]!.conversationId.replace(/^agent-dispatch:/, ""),
    );
    expect(dispatch).toMatchObject({
      destination: { channelId: "C123", threadTs: "1712348.0009" },
      metadata: { eventAutomationId: automation.id },
    });
    expect(dispatch?.credentialSubject).toBeUndefined();
    expect(getCapturedSlackApiCalls("bots.info").at(-1)?.params).toMatchObject({
      bot: "B777",
    });
    expect(getCapturedSlackApiCalls("users.info")).toEqual([]);
  });

  it("runs for app integration posts only when Slack places the bot in this workspace", async () => {
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
        instruction: "Review each new report.",
        title: "Review reports",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger({
          user_id: ["B701", "B702", "B703", "B704", "B705", "B706", "B707"],
        }),
      },
    );
    const post = (
      botId: string,
      ts: string,
      botProfile?: { deleted: boolean; team_id: string },
      envelope: Record<string, unknown> = WORKSPACE_CHANNEL,
    ) =>
      postChannelMessage({
        botId,
        ...(botProfile
          ? { botProfile: { id: botId, app_id: "A123", ...botProfile } }
          : undefined),
        envelope,
        noUser: true,
        ts,
      });

    // A bot_profile from another workspace, a deleted bot_profile, a deleted
    // bot, and a bot user from another workspace run nothing.
    await post("B701", "1712349.0001", { team_id: "T999", deleted: false });
    await post("B702", "1712349.0002", { team_id: TEAM_ID, deleted: true });
    queueSlackApiResponse("bots.info", {
      body: botsInfoOk({ botId: "B703", deleted: true }),
    });
    await post("B703", "1712349.0003");
    queueSlackApiResponse("bots.info", {
      body: botsInfoOk({ botId: "B704", userId: "U704" }),
    });
    const external = usersInfoOk({ userId: "U704", isBot: true });
    queueSlackApiResponse("users.info", {
      body: { ...external, user: { ...external.user, team_id: "TEXTERNAL" } },
    });
    await post("B704", "1712349.0004");
    expect(queue.sentRecords()).toEqual([]);

    // A bot_profile from this workspace needs no lookup. A bot user from this
    // workspace is checked through bots.info and users.info.
    await post("B705", "1712349.0005", { team_id: TEAM_ID, deleted: false });
    queueSlackApiResponse("bots.info", {
      body: botsInfoOk({ botId: "B706", userId: "U706" }),
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U706", isBot: true }),
    });
    await post("B706", "1712349.0006");
    // On Enterprise Grid, a bot_profile from this workspace is enough.
    await post(
      "B707",
      "1712349.0007",
      { team_id: TEAM_ID, deleted: false },
      ENTERPRISE_CHANNEL,
    );
    expect(queue.sentRecords()).toHaveLength(3);
    expect(
      getCapturedSlackApiCalls("bots.info").map((call) => call.params.bot),
    ).toEqual(["B703", "B704", "B706"]);
    expect(
      getCapturedSlackApiCalls("users.info").map((call) => call.params.user),
    ).toEqual(["U704", "U706"]);
  });

  it("runs for thread replies only when its match names the thread location", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    const create = createAutomationTool(
      automationToolContext(channelContext),
      catalog,
    );
    await execute(create, {
      instruction: "Triage each new top-level alert.",
      title: "Triage top-level alerts",
      outcomes: [
        { action: "send_message", destination: "current_conversation" },
      ],
      trigger: trigger({ user_id: "U777" }),
    });
    const { automation } = (await execute(
      create,
      {
        instruction: "Triage each deploy failure.",
        title: "Triage deploy failures",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger({ user_id: "U777", location: ["channel", "thread"] }),
      },
      "thread-automation-call",
    )) as { automation: { id: string } };

    // A bot reply in a Slack thread runs only the automation that names
    // the thread location, and Junior replies in that Slack thread.
    await postChannelMessage({
      botId: "B777",
      threadTs: "1712347.0001",
      ts: "1712347.0002",
      user: "U777",
    });
    const sent = queue.sentRecords();
    expect(sent).toHaveLength(1);
    const dispatch = await getDispatchRecord(
      sent[0]!.conversationId.replace(/^agent-dispatch:/, ""),
    );
    expect(dispatch).toMatchObject({
      destination: { channelId: "C123", threadTs: "1712347.0001" },
      metadata: { eventAutomationId: automation.id },
    });

    // A top-level bot post still runs both.
    await postChannelMessage({
      botId: "B777",
      ts: "1712347.0003",
      user: "U777",
    });
    expect(queue.sentRecords()).toHaveLength(3);
  });

  it("watches only the channel where the automation posts", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );

    await expect(
      execute(
        createAutomationTool(automationToolContext(channelContext), catalog),
        {
          instruction: "Summarize new messages.",
          title: "Summarize secrets",
          outcomes: [],
          trigger: trigger({ channel_id: "C999" }),
        },
      ),
    ).rejects.toThrow("can watch only the channel where it posts");

    // A message runs only automations that post in its own channel, even
    // when a saved row names that channel and posts somewhere else.
    const { automation } = (await execute(
      createAutomationTool(automationToolContext(channelContext), catalog),
      {
        instruction: "Summarize new messages.",
        title: "Summarize messages",
        outcomes: [],
        trigger: trigger(),
      },
    )) as { automation: { id: string } };
    await fixture.sql
      .db()
      .update(juniorAutomations)
      .set({
        channelId: "C999",
        record: sql`jsonb_set(${juniorAutomations.record}, '{destination,channelId}', '"C999"')`,
      })
      .where(eq(juniorAutomations.id, automation.id));
    expect((await postChannelMessage({ ts: "1712345.0006" })).status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);

    // An update cannot drop the channel filter.
    const { automation: scoped } = (await execute(
      createAutomationTool(automationToolContext(channelContext), catalog),
      {
        instruction: "Summarize new messages.",
        title: "Summarize scoped messages",
        outcomes: [],
        trigger: trigger(),
      },
      "create-scoped",
    )) as { automation: { id: string } };
    await execute(
      createUpdateAutomationTool(
        automationToolContext(channelContext),
        catalog,
      ),
      {
        automation_id: scoped.id,
        trigger: { ...trigger(), match: { channel_id: null } },
      },
      "drop-channel",
    );
    expect(await getEventAutomation(fixture.sql.db(), scoped.id)).toMatchObject(
      { trigger: { match: { channelId: "C123" } } },
    );

    // A trigger saved with the channel as its identifier keeps running.
    await fixture.sql
      .db()
      .update(juniorAutomations)
      .set({
        identifier: "C123",
        record: sql`jsonb_set(jsonb_set(${juniorAutomations.record} #- '{trigger,match}', '{trigger,identifier}', '"C123"'), '{trigger,resourceType}', '"channel"')`,
      })
      .where(eq(juniorAutomations.id, scoped.id));
    const saved = await getEventAutomation(fixture.sql.db(), scoped.id);
    expect(saved?.trigger).toMatchObject({ identifier: "C123" });
    expect(saved?.trigger.match).toBeUndefined();
    expect((await postChannelMessage({ ts: "1712345.0007" })).status).toBe(200);
    expect(queue.sentRecords()).toHaveLength(1);

    // A DM is not a channel, so the automation could never run there.
    await expect(
      execute(
        createAutomationTool(
          automationToolContext(
            context("U123", "D123", "private", undefined, TEAM_ID),
          ),
          catalog,
        ),
        {
          instruction: "Summarize new messages.",
          title: "Summarize DMs",
          outcomes: [],
          trigger: trigger(),
        },
      ),
    ).rejects.toThrow("not in a DM");

    // A temporary Watch cannot follow channel messages either.
    await expect(
      execute(createWatchEventsTool(channelContext, catalog), {
        namespace: "slack",
        identifier: "C123",
        resource_type: "channel",
        label: "New messages",
        events: ["message.posted"],
        intent: "Tell me about new messages.",
      }),
    ).rejects.toThrow("Use createAutomation");
  });
});
