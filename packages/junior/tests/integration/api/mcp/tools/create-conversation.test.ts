import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { defineJuniorPlugins } from "@/plugins";
import {
  createConversationWorkHarness,
  createConversationWorkQueueTestAdapter,
} from "../../../../fixtures/conversation-work";
import { createPluginTaskSendTestAdapter } from "../../../../fixtures/plugin-task-queue";
import { finishRun } from "../../../../fixtures/thread-input";
import {
  connectMcpTools,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";

mockMcpDashboardConfig();

describe("createConversation MCP tool", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
  });

  it("starts a Conversation, queues its Turn, and dedupes a retry", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const call = await connectMcpTools(MCP_TEST_VIEWER, "", {
      conversationWorkQueue: () => queue,
    });

    const created = await call("createConversation", {
      idempotencyKey: "first-question",
      message: "Is ingestion healthy?",
      title: "Ingestion health",
    });
    const retried = await call("createConversation", {
      idempotencyKey: "first-question",
      message: "Is ingestion healthy?",
    });
    const { conversationId } = created.structuredContent as {
      conversationId: string;
    };
    const listed = await call("searchConversations");

    expect(created.structuredContent).toEqual({
      conversationId: expect.any(String),
      cursor: expect.any(String),
      messageId: expect.any(String),
      pendingMessages: [
        expect.objectContaining({ text: "Is ingestion healthy?" }),
      ],
      status: "accepted",
      url: expect.stringContaining("/conversations/"),
    });
    expect(retried.structuredContent).toEqual({
      ...(created.structuredContent as object),
      status: "duplicate",
    });
    expect(queue.takeMessageFor(conversationId)).toBeDefined();
    expect(listed.structuredContent).toEqual({
      // The passed title names the Conversation instead of the message.
      conversations: [
        expect.objectContaining({ conversationId, title: "Ingestion health" }),
      ],
    });
  });

  it("is not available without the conversations:write scope", async () => {
    const call = await connectMcpTools(MCP_TEST_VIEWER, "conversations:read");

    const result = await call("createConversation", { message: "Hello" });

    expect(result).toMatchObject({ isError: true });
  });

  it("adds the links of the first Message and of a steered Message to linked work", async () => {
    const docUrl = "https://docs.test/d/1";
    const steeredUrl = "https://docs.test/d/2";
    let steered = false;
    const tasks = createPluginTaskSendTestAdapter();
    const work = await createConversationWorkHarness(
      {
        run: async (run) => {
          if (!steered) {
            steered = true;
            await call("sendMessage", {
              conversationId: run.conversationId,
              delivery: "interrupt",
              message: `Also ${steeredUrl}`,
            });
            await run.durability?.drainSteeringMessages?.(async () => {});
          }
          return await finishRun(run);
        },
      },
      { sendPluginTask: tasks.send },
    );
    const call = await connectMcpTools(MCP_TEST_VIEWER, "", {
      conversationWorkQueue: () => work.queue,
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "docs",
            displayName: "Docs",
            description: "Docs test plugin",
            configKeys: [],
          },
          objectLinks: [
            {
              filters: [{ host: "docs.test", pathPrefix: "/d/" }],
              objectTypes: ["document"],
              canView: async (ctx) => ctx.viewer.email === MCP_TEST_VIEWER,
              resolve: async (_ctx, url) => ({
                kind: "object" as const,
                key: url.pathname,
                label: "Launch plan",
                objectType: "document" as const,
                title: "Launch plan",
                url: url.href,
              }),
            },
          ],
        }),
      ]),
    });
    const { conversationId } = (
      await call("createConversation", { message: `Review ${docUrl}` })
    ).structuredContent as { conversationId: string };
    await work.process(work.queue.takeMessageFor(conversationId));

    // The Turn start and the steered Message each sent an attach task.
    expect(
      tasks.sent().filter(({ message }) => message.plugin === "sent-links"),
    ).toHaveLength(2);
    await tasks.deliver();
    const links = await listConversationAnnotations(getDb(), conversationId);
    expect(
      links
        .map(({ kind, label, objectType, url }) => ({
          kind,
          label,
          objectType,
          url,
        }))
        .sort((a, b) => (a.url ?? "").localeCompare(b.url ?? "")),
    ).toEqual(
      [docUrl, steeredUrl].map((url) => ({
        kind: "resource_link",
        label: url,
        objectType: "document",
        url,
      })),
    );
  });
});
