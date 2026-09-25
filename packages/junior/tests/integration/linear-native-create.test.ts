import { sendSlackReply } from "@/chat/slack/reply";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { linearPlugin } from "../../../junior-linear/src/index.js";
import { getConversationStore, getDb } from "@/chat/db";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { createPluginHookRunner, setPlugins } from "@/chat/plugins/agent-hooks";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { parseInlinePluginManifest } from "@/chat/plugins/manifest";
import { mswServer } from "../msw/server";
import { z } from "zod";

describe("Linear MCP create annotations", () => {
  let manager: McpToolManager | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;

  afterEach(async () => {
    await manager?.close();
    await transport?.close();
    manager = undefined;
    transport = undefined;
  });

  it("annotates created issues from live save_issue calls and updates them", async () => {
    const saveCalls: Array<Record<string, unknown>> = [];
    const server = new McpServer({ name: "linear-test", version: "1.0.0" });
    server.registerTool(
      "save_issue",
      {
        description: "Create or update a Linear issue",
        inputSchema: {
          id: z.string().optional(),
          team: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
          project: z.string().optional(),
          state: z.string().optional(),
        },
      },
      (input) => {
        saveCalls.push(input);
        const action = input.id ? "Updated" : "Created";
        const issueUrl =
          "https://linear.app/acme/issue/ENG-123/native-linear-issue";
        return {
          content: [
            {
              type: "text",
              text: `${action} [ENG-123](${issueUrl})`,
            },
          ],
          // Model-visible MCP results prefer structuredContent over text.
          structuredContent: {
            issue: {
              id: "issue-id",
              identifier: "ENG-123",
              title: input.title ?? "Linear MCP create issue",
              status: input.state ?? "Todo",
              assignee: "Sam",
              priority: "High",
              project: "Quality",
              url: issueUrl,
            },
          },
        };
      },
    );
    server.registerTool(
      "get_issue",
      {
        description: "Get a Linear issue",
        inputSchema: { identifier: z.string() },
      },
      ({ identifier }) => ({
        content: [{ type: "text", text: identifier }],
      }),
    );
    transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => "linear-test-session",
    });
    await server.connect(transport);
    mswServer.use(
      http.all("https://mcp.linear.app/mcp", async ({ request }) =>
        transport!.handleRequest(request),
      ),
    );

    const registration = linearPlugin();
    const previousPlugins = setPlugins([registration]);
    const conversationId = "local:test:linear-mcp-create-annotations";
    const pluginHooks = createPluginHookRunner();
    const manifest = parseInlinePluginManifest(
      {
        ...registration.manifest,
        configKeys: registration.manifest.configKeys ?? [],
      },
      "/plugins/linear",
    );
    manager = new McpToolManager(
      [
        {
          dir: "/plugins/linear",
          skillsDir: "/plugins/linear/skills",
          manifest,
        },
      ],
      {
        onToolSuccess: async (input) => {
          return await pluginHooks.afterMcpTool({
            ...input,
            conversationId,
          });
        },
      },
    );

    try {
      await getConversationStore().recordActivity({
        destination: { platform: "local" as const, conversationId },
        conversationId,
        nowMs: Date.now(),
        source: "local",
        title: "Linear MCP create annotations",
      });

      expect(await manager.activateProvider("linear")).toBe(true);
      const catalog = manager.getActiveToolCatalog();
      expect(catalog.map((tool) => tool.rawName).sort()).toEqual([
        "get_issue",
        "save_issue",
      ]);

      const saveIssue = manager
        .getResolvedActiveTools({ provider: "linear" })
        .find((tool) => tool.rawName === "save_issue");
      if (!saveIssue) {
        throw new Error("save_issue is unavailable after activation");
      }

      const createInput = {
        team: "Engineering",
        title: "Linear MCP create issue",
        description: "Create through the hosted MCP provider.",
        priority: "high",
        project: "Junior",
      } as const;
      const createResult = await saveIssue.execute(createInput);
      expect(createResult).toMatchObject({
        structuredContent: {
          issue: {
            identifier: "ENG-123",
            url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
          },
        },
      });
      expect(createResult.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining('"identifier": "ENG-123"'),
        },
      ]);
      await expect(
        listConversationAnnotations(getDb(), conversationId),
      ).resolves.toMatchObject([
        {
          kind: "object",
          objectType: "task",
          key: "ENG-123",
          label: "ENG-123",
          plugin: "linear",
          url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
        },
      ]);

      expect(createResult.cards).toMatchObject([
        {
          plugin: "linear",
          objectType: "task",
          status: "Todo",
          title: "Linear MCP create issue",
        },
      ]);
      await sendSlackReply({
        channelId: "C123",
        conversationId,
        text: "Created the issue.",
        cards: createResult.cards,
      });
      expect(
        getCapturedSlackApiCalls("chat.postMessage").at(-1)?.params.metadata,
      ).toMatchObject({
        entities: [
          {
            entity_type: "slack#/entities/task",
            entity_payload: { fields: { status: { value: "Todo" } } },
          },
        ],
      });
      const updateResult = await createCallMcpToolTool(manager).execute!(
        {
          tool_name: saveIssue.name,
          arguments: { id: "ENG-123", state: "In Progress" },
        },
        {},
      );
      await expect(
        listConversationAnnotations(getDb(), conversationId),
      ).resolves.toHaveLength(1);

      expect(updateResult.details.objectCards).toMatchObject([
        {
          plugin: "linear",
          key: "ENG-123",
          status: "In Progress",
          facts: {
            type: "task",
            assignees: ["Sam"],
            priority: "High",
            project: "Quality",
          },
        },
      ]);
      expect(saveCalls).toEqual([
        createInput,
        { id: "ENG-123", state: "In Progress" },
      ]);
    } finally {
      setPlugins(previousPlugins);
      await server.close();
    }
  });

  it("keeps the tool result when annotation processing fails", async () => {
    const server = new McpServer({ name: "linear-test", version: "1.0.0" });
    server.registerTool(
      "save_issue",
      {
        description: "Create or update a Linear issue",
        inputSchema: {
          team: z.string().optional(),
          title: z.string().optional(),
        },
      },
      () => ({
        content: [
          {
            type: "text",
            text: "Created [ENG-999](https://linear.app/acme/issue/ENG-999/hook-failure)",
          },
        ],
      }),
    );
    transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => "linear-test-session-hook-failure",
    });
    await server.connect(transport);
    mswServer.use(
      http.all("https://mcp.linear.app/mcp", async ({ request }) =>
        transport!.handleRequest(request),
      ),
    );

    const registration = linearPlugin();
    const previousPlugins = setPlugins([
      {
        ...registration,
        hooks: {
          ...registration.hooks,
          afterMcpTool: async () => {
            throw new Error("annotation failed");
          },
        },
      },
    ]);
    const conversationId = "local:test:linear-mcp-create-hook-failure";
    const pluginHooks = createPluginHookRunner();
    const manifest = parseInlinePluginManifest(
      {
        ...registration.manifest,
        configKeys: registration.manifest.configKeys ?? [],
      },
      "/plugins/linear",
    );
    manager = new McpToolManager(
      [
        {
          dir: "/plugins/linear",
          skillsDir: "/plugins/linear/skills",
          manifest,
        },
      ],
      {
        onToolSuccess: async (input) => {
          return await pluginHooks.afterMcpTool({
            ...input,
            conversationId,
          });
        },
      },
    );

    try {
      await getConversationStore().recordActivity({
        destination: { platform: "local" as const, conversationId },
        conversationId,
        nowMs: Date.now(),
        source: "local",
        title: "Linear MCP create hook failure",
      });
      expect(await manager.activateProvider("linear")).toBe(true);
      const saveIssue = manager
        .getResolvedActiveTools({ provider: "linear" })
        .find((tool) => tool.rawName === "save_issue");
      if (!saveIssue) {
        throw new Error("save_issue is unavailable after activation");
      }

      await expect(
        saveIssue.execute({
          team: "Engineering",
          title: "Hook failure should not break create",
        }),
      ).resolves.toMatchObject({
        content: [
          {
            type: "text",
            text: "Created [ENG-999](https://linear.app/acme/issue/ENG-999/hook-failure)",
          },
        ],
      });
      await expect(
        listConversationAnnotations(getDb(), conversationId),
      ).resolves.toEqual([]);
    } finally {
      setPlugins(previousPlugins);
      await server.close();
    }
  });
});
