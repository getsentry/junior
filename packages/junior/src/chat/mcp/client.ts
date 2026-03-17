import { Client } from "@modelcontextprotocol/sdk/client";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginDefinition } from "@/chat/plugins/types";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const MCP_CLIENT_INFO = {
  name: "junior-mcp-client",
  version: "1.0.0",
};

export class McpAuthorizationRequiredError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = "McpAuthorizationRequiredError";
    this.provider = provider;
  }
}

export interface PluginMcpClientOptions {
  authProvider?: OAuthClientProvider;
  fetch?: typeof fetch;
  sessionId?: string;
}

export class PluginMcpClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private listedTools?: ListedTool[];

  constructor(
    private readonly plugin: PluginDefinition,
    private readonly options: PluginMcpClientOptions = {},
  ) {}

  async listTools(): Promise<ListedTool[]> {
    if (this.listedTools) {
      return [...this.listedTools];
    }

    const client = await this.getClient();
    const discovered: ListedTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    do {
      const result = await this.wrapAuth(
        client.listTools(cursor ? { cursor } : undefined),
      );
      for (const tool of result.tools) {
        if (seen.has(tool.name)) {
          continue;
        }
        seen.add(tool.name);
        discovered.push(tool);
      }
      cursor = result.nextCursor;
    } while (cursor);

    this.listedTools = discovered.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    return [...this.listedTools];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<ToolCallResult> {
    const client = await this.getClient();
    return await this.wrapAuth(
      client.callTool({
        name,
        ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
      }),
    );
  }

  async close(): Promise<void> {
    this.listedTools = undefined;

    const transport = this.transport;
    this.transport = undefined;
    this.client = undefined;

    if (transport) {
      await transport.close();
    }
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const mcp = this.plugin.manifest.mcp;
    if (!mcp) {
      throw new Error(
        `Plugin "${this.plugin.manifest.name}" does not declare MCP config`,
      );
    }

    const requestInit: RequestInit = {};
    if (mcp.headers && Object.keys(mcp.headers).length > 0) {
      requestInit.headers = new Headers(mcp.headers);
    }

    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
      ...(Object.keys(requestInit).length > 0 ? { requestInit } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.authProvider
        ? { authProvider: this.options.authProvider }
        : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    });
    const client = new Client(MCP_CLIENT_INFO, {
      capabilities: {},
    });

    await this.wrapAuth(client.connect(transport));

    this.transport = transport;
    this.client = client;
    return client;
  }

  private async wrapAuth<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof McpAuthorizationRequiredError) {
        throw error;
      }
      if (error instanceof UnauthorizedError) {
        throw new McpAuthorizationRequiredError(
          this.plugin.manifest.name,
          `MCP authorization required for plugin "${this.plugin.manifest.name}"`,
        );
      }
      if (error instanceof StreamableHTTPError && error.code === 401) {
        throw new McpAuthorizationRequiredError(
          this.plugin.manifest.name,
          `MCP authorization required for plugin "${this.plugin.manifest.name}"`,
        );
      }
      throw error;
    }
  }
}

export type {
  ListedTool as PluginMcpListedTool,
  ToolCallResult as PluginMcpToolCallResult,
};
