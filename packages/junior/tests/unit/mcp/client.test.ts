import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

const {
  callToolMock,
  connectMock,
  listToolsMock,
  setSpanAttributesMock,
  transportOptions,
} = vi.hoisted(() => ({
  callToolMock: vi.fn(),
  connectMock: vi.fn(),
  listToolsMock: vi.fn(),
  setSpanAttributesMock: vi.fn(),
  transportOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => {
  class UnauthorizedError extends Error {
    constructor(message?: string) {
      super(message ?? "Unauthorized");
      this.name = "UnauthorizedError";
    }
  }

  return {
    UnauthorizedError,
  };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  class StreamableHTTPError extends Error {
    readonly code: number | undefined;

    constructor(code: number | undefined, message: string | undefined) {
      super(`Streamable HTTP error: ${message}`);
      this.code = code;
      this.name = "StreamableHTTPError";
    }
  }

  class StreamableHTTPClientTransport {
    protocolVersion?: string;
    sessionId?: string;

    constructor(
      _url: URL,
      options?: {
        sessionId?: string;
      },
    ) {
      this.sessionId = options?.sessionId;
      transportOptions.push({ ...(options ?? {}) });
    }

    async close() {}

    setProtocolVersion(version: string) {
      this.protocolVersion = version;
    }
  }

  return {
    StreamableHTTPClientTransport,
    StreamableHTTPError,
  };
});

vi.mock("@modelcontextprotocol/sdk/client", () => ({
  Client: class Client {
    private transport?: { sessionId?: string };

    constructor() {}

    async connect(transport: { sessionId?: string }) {
      this.transport = transport;
      return await connectMock(transport);
    }

    async listTools(args?: unknown) {
      return await listToolsMock(this.transport, args);
    }

    async callTool(args: unknown) {
      return await callToolMock(this.transport, args);
    }
  },
}));

vi.mock("@/chat/logging", () => ({
  setSpanAttributes: setSpanAttributesMock,
}));

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpAuthorizationRequiredError,
  PluginMcpClient,
} from "@/chat/mcp/client";

function buildPlugin() {
  return {
    dir: "/tmp/plugins/notion",
    skillsDir: "/tmp/plugins/notion/skills",
    manifest: {
      name: "notion",
      description: "Notion MCP",
      capabilities: [],
      configKeys: [],
      mcp: {
        transport: "http" as const,
        url: "https://mcp.notion.com/mcp",
      },
    },
  };
}

function buildAuthProvider() {
  return {
    getMcpServerSessionId: vi.fn<() => Promise<string | undefined>>(),
    saveMcpServerSessionId:
      vi.fn<(sessionId: string | undefined) => Promise<void>>(),
    redirectUrl: "https://junior.example.com/api/oauth/callback/mcp/notion",
    clientMetadata: {
      client_name: "Junior MCP Client",
      redirect_uris: [
        "https://junior.example.com/api/oauth/callback/mcp/notion",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: vi.fn(async () => "auth-state"),
    clientInformation: vi.fn(async () => undefined),
    saveClientInformation: vi.fn(async () => undefined),
    tokens: vi.fn(async () => undefined),
    saveTokens: vi.fn(async () => undefined),
    redirectToAuthorization: vi.fn(async () => undefined),
    saveCodeVerifier: vi.fn(async () => undefined),
    codeVerifier: vi.fn(async () => "code-verifier"),
  } satisfies OAuthClientProvider & {
    getMcpServerSessionId: () => Promise<string | undefined>;
    saveMcpServerSessionId: (sessionId: string | undefined) => Promise<void>;
  };
}

describe("PluginMcpClient", () => {
  beforeEach(() => {
    callToolMock.mockReset();
    connectMock.mockReset();
    listToolsMock.mockReset();
    setSpanAttributesMock.mockReset();
    transportOptions.length = 0;
  });

  it("reuses and refreshes host-managed MCP server session ids", async () => {
    const authProvider = buildAuthProvider();
    authProvider.getMcpServerSessionId.mockResolvedValue("stored-session");
    authProvider.saveMcpServerSessionId.mockResolvedValue(undefined);
    connectMock.mockImplementation(
      async (transport: { sessionId?: string }) => {
        transport.sessionId = "server-session";
      },
    );
    listToolsMock.mockResolvedValue({
      tools: [
        {
          name: "notion-search",
          title: "Search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      nextCursor: undefined,
    });

    const client = new PluginMcpClient(buildPlugin(), { authProvider });

    await expect(client.listTools()).resolves.toHaveLength(1);
    expect(transportOptions[0]).toMatchObject({ sessionId: "stored-session" });
    expect(authProvider.saveMcpServerSessionId).toHaveBeenCalledWith(
      "server-session",
    );
  });

  it("persists the server-issued MCP session before surfacing an auth challenge", async () => {
    const authProvider = buildAuthProvider();
    authProvider.getMcpServerSessionId.mockResolvedValue(undefined);
    authProvider.saveMcpServerSessionId.mockResolvedValue(undefined);
    connectMock.mockImplementation(
      async (transport: { sessionId?: string }) => {
        transport.sessionId = "auth-session";
        throw new UnauthorizedError("auth required");
      },
    );

    const client = new PluginMcpClient(buildPlugin(), { authProvider });

    await expect(client.listTools()).rejects.toBeInstanceOf(
      McpAuthorizationRequiredError,
    );
    expect(authProvider.saveMcpServerSessionId).toHaveBeenCalledWith(
      "auth-session",
    );
  });

  it("does not relabel raw 401 transport failures as auth challenges", async () => {
    const authProvider = buildAuthProvider();
    authProvider.getMcpServerSessionId.mockResolvedValue(undefined);
    authProvider.saveMcpServerSessionId.mockResolvedValue(undefined);
    connectMock.mockRejectedValueOnce(
      new StreamableHTTPError(
        401,
        "Server returned 401 after successful authentication",
      ),
    );

    const client = new PluginMcpClient(buildPlugin(), { authProvider });

    await expect(client.listTools()).rejects.toBeInstanceOf(
      StreamableHTTPError,
    );
  });

  it("sends an empty arguments object for no-argument MCP tool calls", async () => {
    const authProvider = buildAuthProvider();
    authProvider.getMcpServerSessionId.mockResolvedValue(undefined);
    authProvider.saveMcpServerSessionId.mockResolvedValue(undefined);
    connectMock.mockImplementation(
      async (transport: {
        sessionId?: string;
        setProtocolVersion: (version: string) => void;
      }) => {
        transport.sessionId = "server-session";
        transport.setProtocolVersion("2025-11-25");
      },
    );
    callToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const client = new PluginMcpClient(buildPlugin(), { authProvider });

    await expect(client.callTool("notion-search", undefined)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(callToolMock).toHaveBeenCalledWith(expect.anything(), {
      name: "notion-search",
      arguments: {},
    });
    expect(setSpanAttributesMock).toHaveBeenCalledWith({
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "notion-search",
      "mcp.session.id": "server-session",
      "mcp.protocol.version": "2025-11-25",
      "server.address": "mcp.notion.com",
      "server.port": 443,
      "network.protocol.name": "http",
      "network.transport": "tcp",
    });
  });

  it("clears a stale MCP server session and retries once with a fresh transport", async () => {
    const authProvider = buildAuthProvider();
    authProvider.getMcpServerSessionId
      .mockResolvedValueOnce("stale-session")
      .mockResolvedValue(undefined);
    authProvider.saveMcpServerSessionId.mockResolvedValue(undefined);
    connectMock
      .mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found"))
      .mockImplementationOnce(async (transport: { sessionId?: string }) => {
        transport.sessionId = "fresh-session";
      });
    listToolsMock.mockResolvedValue({
      tools: [
        {
          name: "notion-search",
          title: "Search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      nextCursor: undefined,
    });

    const client = new PluginMcpClient(buildPlugin(), { authProvider });

    await expect(client.listTools()).resolves.toHaveLength(1);
    expect(authProvider.saveMcpServerSessionId).toHaveBeenCalledWith(undefined);
    expect(transportOptions).toEqual([
      { authProvider, sessionId: "stale-session" },
      { authProvider },
    ]);
  });

  it("drops cached listed tools when session recovery rebuilds the client", async () => {
    const authProvider = buildAuthProvider();
    authProvider.getMcpServerSessionId
      .mockResolvedValueOnce("stale-session")
      .mockResolvedValue(undefined);
    authProvider.saveMcpServerSessionId.mockResolvedValue(undefined);
    connectMock.mockImplementation(async () => undefined);
    listToolsMock
      .mockResolvedValueOnce({
        tools: [
          {
            name: "notion-search",
            title: "Search",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        nextCursor: undefined,
      })
      .mockResolvedValueOnce({
        tools: [
          {
            name: "notion-query",
            title: "Query",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        nextCursor: undefined,
      });
    callToolMock
      .mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    const client = new PluginMcpClient(buildPlugin(), { authProvider });

    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "notion-search" }),
    ]);
    await expect(client.callTool("notion-search", undefined)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(callToolMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      name: "notion-search",
      arguments: {},
    });
    expect(callToolMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      name: "notion-search",
      arguments: {},
    });
    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "notion-query" }),
    ]);
  });
});
