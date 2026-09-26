import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import {
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  createPluginAnnotations,
  listConversationAnnotations,
} from "@/chat/plugins/annotations";
import { getConversationEventStore, getDb } from "@/chat/db";
import { loadPendingMessageCards } from "@/chat/conversations/pending-cards";
import { sendSlackReply } from "@/chat/slack/reply";
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "../fixtures/conversation";
import { createModelStream } from "../fixtures/model-stream";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

const annotation: ObjectAnnotation = {
  kind: "object",
  objectType: "code_change",
  key: "repo#1",
  label: "repo#1",
  title: "Fix the parser",
  url: "https://example.com/pull/1",
  status: "open",
  sourceUpdatedAt: "2026-09-25T12:00:00Z",
  facts: {
    type: "code_change",
    author: "alex",
    review: "required",
    mergeable: true,
    additions: 20,
    deletions: 5,
    sourceBranch: "feature/parser",
    targetBranch: "main",
    changedFiles: 2,
  },
};

afterEach(closeConversationFixture);

it("saves plugin object results once per reply, leaves background updates silent, and preserves Message snapshots", async () => {
  const previous = setPlugins([
    defineJuniorPlugin({
      manifest: {
        name: "objects",
        displayName: "Objects",
        description: "Object test tools",
      },
      hooks: {
        tools: () => ({
          save: definePluginTool({
            approvalMode: "approve",
            exposure: "direct",
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              readOnlyHint: true,
            },
            description: "Return a verified object for this test.",
            inputSchema: z.object({
              fail: z.boolean().optional(),
              timed_out: z.boolean().optional(),
              status: z.string().optional(),
            }),
            outputSchema: pluginToolOutputSchema,
            execute: ({ fail, timed_out, status }) => {
              if (fail) throw new Error("Object update failed");
              return {
                timed_out,
                objectAnnotations: [
                  { ...annotation, status: status ?? "open" },
                ],
              };
            },
          }),
        }),
      },
    }),
  ]);
  const previousDashboard = setDashboardConversationLinkOptions({
    baseURL: "https://junior.example.com",
    basePath: "/ops",
  });
  try {
    const harness = await createConversationWebHarness(
      createModelStream([
        {
          type: "toolCall",
          name: "executeTool",
          arguments: { tool_name: "objects_save", arguments: {} },
        },
        {
          type: "toolCall",
          // PR creation is a direct plugin tool, not a catalog call.
          name: "objects_save",
          arguments: { status: "draft" },
        },
        {
          type: "toolCall",
          name: "executeTool",
          arguments: {
            tool_name: "objects_save",
            arguments: { status: "closed", timed_out: true },
          },
        },
        {
          type: "toolCall",
          name: "executeTool",
          arguments: { tool_name: "objects_save", arguments: { fail: true } },
        },
        { type: "text", text: "The object is ready; the later update failed." },
      ]),
    );
    const { conversationId } = await harness.start({
      idempotencyKey: "objects-1",
      message: "Show the object.",
    });
    await harness.drain();
    const history =
      await getConversationEventStore().loadHistory(conversationId);
    const message = history.find(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    );
    const cards = [{ ...annotation, plugin: "objects", status: "draft" }];
    expect(message?.data).toMatchObject({ meta: { objectCards: cards } });
    if (!message || message.data.type !== "message")
      throw new Error("Expected an assistant Message");
    expect(message.data.meta?.objectCards).toHaveLength(1);
    // Old readers must never receive object cards in their Automation-only field.
    expect(message.data.meta).not.toHaveProperty("cards");
    const toolResults = history
      .map((event) => event.data)
      .filter((data) => data.type === "tool_result");
    for (const result of toolResults) {
      expect(result.details).not.toHaveProperty("cards");
    }
    const selectedResults = toolResults.filter(
      (result) =>
        result.details &&
        typeof result.details === "object" &&
        "objectCards" in result.details,
    );
    expect(selectedResults).toHaveLength(2);
    for (const result of selectedResults) {
      expect(result.details).not.toHaveProperty("objectAnnotations");
    }

    await expect(
      listConversationAnnotations(getDb(), conversationId),
    ).resolves.toMatchObject(cards);
    await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([]);
    await sendSlackReply({
      channelId: "C123",
      conversationId,
      text: "The object is ready.",
      cards,
    });
    expect(
      getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params.metadata,
    ).toEqual({
      entities: [
        {
          entity_type: "slack#/entities/item",
          external_ref: {
            id: Buffer.from(
              JSON.stringify([conversationId, "objects", "repo#1"]),
            ).toString("base64url"),
            type: "annotation",
          },
          url: annotation.url,
          entity_payload: {
            attributes: {
              title: { text: "Fix the parser" },
              display_id: "repo#1",
              display_type: "Code change",
              product_icon: {
                url: "https://junior.example.com/_junior/dashboard/object-icons/v1/git-pull-request-draft.png",
                alt_text: "Code change: draft",
              },
              product_name: "objects",
            },
            display_order: [
              "status",
              "review",
              "author",
              "sourceBranch",
              "targetBranch",
            ],
            custom_fields: [
              {
                key: "status",
                label: "Status",
                type: "string",
                value: "draft",
              },
              {
                key: "review",
                label: "Review",
                type: "string",
                value: "Review required",
              },
              { key: "author", label: "Author", type: "string", value: "alex" },
              {
                key: "sourceBranch",
                label: "From",
                type: "string",
                value: "feature/parser",
              },
              {
                key: "targetBranch",
                label: "Into",
                type: "string",
                value: "main",
              },
            ],
          },
        },
      ],
    });

    const mixedCards = [
      { ...annotation, plugin: "objects", status: "closed", facts: undefined },
      {
        ...annotation,
        plugin: "objects",
        key: "issue-1",
        objectType: "task" as const,
        status: "closed",
        facts: undefined,
      },
      {
        ...annotation,
        plugin: "objects",
        key: "deploy-1",
        objectType: "deployment" as const,
        status: "ERROR",
        facts: { type: "deployment" as const, environment: "production" },
      },
      {
        ...annotation,
        plugin: "junior",
        key: "daily",
        objectType: "automation" as const,
        trigger: "Every day",
        status: "blocked",
        warning: "Reconnect provider",
        facts: undefined,
      },
    ];
    await sendSlackReply({
      channelId: "C123",
      conversationId,
      text: "Linked work",
      cards: mixedCards,
    });
    const mixedPost =
      getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params;
    expect(mixedPost?.metadata).toMatchObject({
      entities: [
        {
          entity_type: "slack#/entities/item",
          entity_payload: {
            attributes: {
              display_type: "Code change",
              product_icon: {
                url: "https://junior.example.com/_junior/dashboard/object-icons/v1/git-pull-request-closed.png",
              },
            },
          },
        },
        {
          entity_type: "slack#/entities/task",
          entity_payload: {
            attributes: {
              display_type: "Ticket",
              product_icon: {
                url: "https://junior.example.com/_junior/dashboard/object-icons/v1/issue-closed.png",
              },
            },
            fields: { status: { value: "closed" } },
          },
        },
        {
          entity_type: "slack#/entities/item",
          entity_payload: {
            attributes: {
              display_type: "Deployment",
              product_icon: {
                url: "https://junior.example.com/_junior/dashboard/object-icons/v1/rocket.png",
              },
            },
          },
        },
        {
          entity_type: "slack#/entities/item",
          entity_payload: {
            attributes: {
              display_type: "Automation",
              product_icon: {
                url: "https://junior.example.com/_junior/dashboard/object-icons/v1/workflow.png",
              },
            },
            custom_fields: expect.arrayContaining([
              expect.objectContaining({
                key: "warning",
                value: "Reconnect provider",
              }),
            ]),
          },
        },
      ],
    });
    for (const type of ["Code change", "Ticket", "Deployment", "Automation"])
      expect(mixedPost?.text).toContain(type);
    setDashboardConversationLinkOptions(undefined);
    await sendSlackReply({
      channelId: "C123",
      conversationId,
      text: "Linked work",
      cards: [mixedCards[0]!, { ...mixedCards[1]!, url: null }],
    });
    const headless =
      getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params;
    expect(headless?.metadata).toMatchObject({
      entities: [
        { entity_payload: { attributes: { display_type: "Code change" } } },
      ],
    });
    expect(JSON.stringify(headless?.metadata)).not.toContain("product_icon");
    expect(headless?.text).toContain("Ticket");
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
      basePath: "/ops",
    });

    await createPluginAnnotations({
      conversationId,
      plugin: "objects",
      db: getDb(),
    }).upsert({ ...annotation, status: "merged" });
    await expect(loadPendingMessageCards(conversationId)).resolves.toEqual([]);
    const saved = await getConversationEventStore().loadHistory(conversationId);
    expect(
      saved.find((event) => event.seq === message?.seq)?.data,
    ).toMatchObject({ meta: { objectCards: cards } });

    harness.setModelStream(
      createModelStream([{ type: "text", text: "The object has merged." }]),
    );
    await harness.continue({
      conversationId,
      idempotencyKey: "objects-2",
      message: "Any news?",
    });
    await harness.drain();
    const later = (
      await getConversationEventStore().loadHistory(conversationId)
    )
      .filter(
        (event) =>
          event.data.type === "message" && event.data.role === "assistant",
      )
      .at(-1);
    expect(later?.data).not.toHaveProperty("meta.objectCards");

    harness.setModelStream(
      createModelStream([
        {
          type: "toolCall",
          name: "executeTool",
          arguments: { tool_name: "objects_save", arguments: {} },
        },
        { type: "text", text: "[[NO_REPLY]]" },
      ]),
    );
    await harness.continue({
      conversationId,
      idempotencyKey: "objects-3",
      message: "Keep this turn silent.",
    });
    await harness.drain();
    harness.setModelStream(
      createModelStream([{ type: "text", text: "Nothing new." }]),
    );
    await harness.continue({
      conversationId,
      idempotencyKey: "objects-4",
      message: "Any news?",
    });
    await harness.drain();
    const last = (await getConversationEventStore().loadHistory(conversationId))
      .filter(
        (event) =>
          event.data.type === "message" && event.data.role === "assistant",
      )
      .at(-1);
    expect(last?.data).not.toHaveProperty("meta.objectCards");
  } finally {
    setPlugins(previous);
    setDashboardConversationLinkOptions(previousDashboard);
  }
});
