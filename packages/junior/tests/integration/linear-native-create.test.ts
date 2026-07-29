import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { linearPlugin } from "../../../junior-linear/src/index.js";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb } from "@/chat/db";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { parseInlinePluginManifest } from "@/chat/plugins/manifest";
import { mswServer } from "../msw/server";
import { z } from "zod";

describe("Linear native create tool", () => {
  let manager: McpToolManager | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;

  afterEach(async () => {
    await manager?.close();
    await transport?.close();
    manager = undefined;
    transport = undefined;
  });

  it("creates through hosted MCP, hides the raw tool, and annotates once", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const server = new McpServer({ name: "linear-test", version: "1.0.0" });
    server.registerTool(
      "create_issue",
      {
        description: "Create a Linear issue",
        inputSchema: {
          team: z.string(),
          title: z.string(),
          description: z.string().optional(),
          priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
          project: z.string().optional(),
        },
      },
      (input) => {
        createCalls.push(input);
        return {
          content: [{ type: "text", text: "Created ENG-123" }],
          structuredContent: {
            issue: {
              id: "issue-id",
              identifier: "ENG-123",
              title: input.title,
              url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
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
    const manifest = parseInlinePluginManifest(
      {
        ...registration.manifest,
        configKeys: registration.manifest.configKeys ?? [],
      },
      "/plugins/linear",
    );
    manager = new McpToolManager([
      {
        dir: "/plugins/linear",
        skillsDir: "/plugins/linear/skills",
        manifest,
      },
    ]);
    const previousPlugins = setPlugins([registration]);
    const conversationId = "local:test:linear-native-create";
    try {
      await getConversationStore().recordActivity({
        conversationId,
        nowMs: Date.now(),
        source: "local",
        title: "Linear native create",
      });
      const tools = getPluginTools({
        conversationId,
        destination: { platform: "local", conversationId },
        egress: {
          async fetch() {
            return new Response("unused");
          },
        },
        mcpToolManager: manager,
        source: createLocalSource(conversationId),
        workspace: {} as never,
      });
      const createIssue = tools.linear_createIssue;
      if (!createIssue?.execute) {
        throw new Error("Linear createIssue tool is unavailable");
      }

      expect(await manager.activateProvider("linear")).toBe(true);
      expect(manager.getActiveToolCatalog()).toMatchObject([
        { provider: "linear", rawName: "get_issue" },
      ]);
      const input = {
        team: "Engineering",
        title: "Native Linear issue",
        description: "Create through the hosted MCP provider.",
        priority: "high",
        project: "Junior",
      } as const;

      await expect(
        createIssue.execute(input, { toolCallId: "call-create" }),
      ).resolves.toMatchObject({
        ok: true,
        status: "success",
        target: "createIssue",
        issue: {
          identifier: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
        },
      });
      await createIssue.execute(input, { toolCallId: "call-create" });

      expect(createCalls).toEqual([input]);
      await expect(
        listConversationAnnotations(getDb(), conversationId),
      ).resolves.toMatchObject([
        {
          kind: "resource_link",
          key: "ENG-123",
          label: "ENG-123",
          plugin: "linear",
          status: "open",
          url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
        },
      ]);
    } finally {
      setPlugins(previousPlugins);
      await server.close();
    }
  });
});
