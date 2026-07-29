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

describe("Linear native issue tools", () => {
  let manager: McpToolManager | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;

  afterEach(async () => {
    await manager?.close();
    await transport?.close();
    manager = undefined;
    transport = undefined;
  });

  it("creates and updates through hosted MCP while hiding the raw tool", async () => {
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
        return {
          content: [
            {
              type: "text",
              text: `${action} [ENG-123](https://linear.app/acme/issue/ENG-123/native-linear-issue)`,
            },
          ],
          structuredContent: {
            issue: {
              id: "issue-id",
              title: input.title,
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
      const updateIssue = tools.linear_updateIssue;
      if (!createIssue?.execute || !updateIssue?.execute) {
        throw new Error("Linear native issue tools are unavailable");
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
        content: [
          {
            type: "text",
            text: "Created [ENG-123](https://linear.app/acme/issue/ENG-123/native-linear-issue)",
          },
        ],
        details: {
          ok: true,
          status: "success",
          target: "createIssue",
          issue: {
            identifier: "ENG-123",
            url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
          },
        },
      });
      await expect(
        createIssue.execute(input, { toolCallId: "call-create" }),
      ).resolves.toMatchObject({
        content: [
          {
            type: "text",
            text: "Created [ENG-123](https://linear.app/acme/issue/ENG-123/native-linear-issue)",
          },
        ],
      });

      const updateInput = {
        id: "ENG-123",
        state: "In Progress",
      };
      expect(() =>
        updateIssue.prepareArguments?.({ id: "ENG-123", state: null }),
      ).toThrow("Invalid tool arguments: state:");
      await expect(
        updateIssue.execute(updateInput, { toolCallId: "call-update" }),
      ).resolves.toMatchObject({
        content: [
          {
            type: "text",
            text: "Updated [ENG-123](https://linear.app/acme/issue/ENG-123/native-linear-issue)",
          },
        ],
        details: {
          ok: true,
          status: "success",
          target: "updateIssue",
        },
      });

      expect(saveCalls).toEqual([input, input, updateInput]);
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

  it("retries the same create after authorization pauses during the provider call", async () => {
    const registration = linearPlugin();
    const previousPlugins = setPlugins([registration]);
    const conversationId = "local:test:linear-native-auth-resume";
    let callCount = 0;
    const activeProviders = new Set(["linear"]);
    try {
      await getConversationStore().recordActivity({
        conversationId,
        nowMs: Date.now(),
        source: "local",
        title: "Linear native auth resume",
      });
      const tools = getPluginTools({
        conversationId,
        destination: { platform: "local", conversationId },
        egress: {
          async fetch() {
            return new Response("unused");
          },
        },
        mcpToolManager: {
          async activateProvider() {
            activeProviders.add("linear");
            return true;
          },
          async callWrappedTool() {
            callCount += 1;
            if (callCount === 1) {
              activeProviders.delete("linear");
              return {
                status: "authorization_pending" as const,
              };
            }
            return {
              status: "success" as const,
              content: [{ type: "text" as const, text: "Created ENG-456" }],
              structuredContent: {
                issue: {
                  identifier: "ENG-456",
                  url: "https://linear.app/acme/issue/ENG-456/auth-resume",
                },
              },
            };
          },
          getActiveProviders() {
            return [...activeProviders];
          },
        } as never,
        source: createLocalSource(conversationId),
        workspace: {} as never,
      });
      const createIssue = tools.linear_createIssue;
      if (!createIssue?.execute) {
        throw new Error("Linear createIssue tool is unavailable");
      }
      const input = { team: "Engineering", title: "Resume after auth" };

      await expect(
        createIssue.execute(input, { toolCallId: "call-auth" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "Authorization pending." }],
        details: { issue: null },
      });
      await expect(
        createIssue.execute(input, { toolCallId: "call-auth" }),
      ).resolves.toMatchObject({
        details: {
          issue: {
            identifier: "ENG-456",
            url: "https://linear.app/acme/issue/ENG-456/auth-resume",
          },
        },
      });
      expect(callCount).toBe(2);
    } finally {
      setPlugins(previousPlugins);
    }
  });

  it("allows caller retries after provider and transport failures", async () => {
    const registration = linearPlugin();
    const previousPlugins = setPlugins([registration]);
    const conversationId = "local:test:linear-native-create-failures";
    const callCounts = new Map<string, number>();
    const activeProviders = new Set(["linear"]);
    try {
      await getConversationStore().recordActivity({
        conversationId,
        nowMs: Date.now(),
        source: "local",
        title: "Linear native create failures",
      });
      const tools = getPluginTools({
        conversationId,
        destination: { platform: "local", conversationId },
        egress: {
          async fetch() {
            return new Response("unused");
          },
        },
        mcpToolManager: {
          async activateProvider() {
            activeProviders.add("linear");
            return true;
          },
          async callWrappedTool(
            _provider: string,
            _name: string,
            _arguments: Record<string, unknown>,
            options?: { toolCallId?: string },
          ) {
            const toolCallId = options?.toolCallId ?? "";
            const callCount = (callCounts.get(toolCallId) ?? 0) + 1;
            callCounts.set(toolCallId, callCount);

            if (toolCallId === "call-rejected" && callCount === 1) {
              return {
                status: "error" as const,
                message: "Team is invalid",
              };
            }
            if (toolCallId === "call-uncertain" && callCount === 1) {
              throw new Error("MCP transport failed");
            }
            return {
              status: "success" as const,
              content: [{ type: "text" as const, text: "Created" }],
            };
          },
          getActiveProviders() {
            return [...activeProviders];
          },
        } as never,
        source: createLocalSource(conversationId),
        workspace: {} as never,
      });
      const createIssue = tools.linear_createIssue;
      if (!createIssue?.execute) {
        throw new Error("Linear createIssue tool is unavailable");
      }
      const input = { team: "Engineering", title: "Failure semantics" };

      await expect(
        createIssue.execute(input, { toolCallId: "call-rejected" }),
      ).rejects.toThrow("Team is invalid");
      await expect(
        createIssue.execute(input, { toolCallId: "call-rejected" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "Created" }],
        details: {
          ok: true,
          status: "success",
        },
      });
      expect(callCounts.get("call-rejected")).toBe(2);

      await expect(
        createIssue.execute(input, { toolCallId: "call-uncertain" }),
      ).rejects.toThrow("MCP transport failed");
      await expect(
        createIssue.execute(input, { toolCallId: "call-uncertain" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "Created" }],
      });
      expect(callCounts.get("call-uncertain")).toBe(2);
    } finally {
      setPlugins(previousPlugins);
    }
  });
});
