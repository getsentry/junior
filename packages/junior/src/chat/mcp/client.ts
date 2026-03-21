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
}

type HostManagedSessionProvider = OAuthClientProvider & {
  getMcpServerSessionId?: () => Promise<string | undefined>;
  saveMcpServerSessionId?: (sessionId: string | undefined) => Promise<void>;
};

export class PluginMcpClient {
  private client?: Client;
  private lastAttemptedTransportSessionId?: string;
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

    return await this.withSessionRecovery(async () => {
      const client = await this.getClient();
      const discovered: ListedTool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;

      do {
        const result = await this.wrapAuth(
          client.listTools(cursor ? { cursor } : undefined),
        );
        await this.syncTransportSessionId();
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
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<ToolCallResult> {
    return await this.withSessionRecovery(async () => {
      const client = await this.getClient();
      const result = await this.wrapAuth(
        client.callTool({
          name,
          ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
        }),
      );
      await this.syncTransportSessionId();
      return result;
    });
  }

  async close(): Promise<void> {
    await this.disposeClient();
  }

  private async withSessionRecovery<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.syncTransportSessionId();
      if (!(await this.shouldResetMissingSession(error))) {
        throw error;
      }

      await this.clearStoredTransportSessionId();
      await this.disposeClient();
      return await operation();
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

    const sessionId = await this.getStoredTransportSessionId();
    this.lastAttemptedTransportSessionId = sessionId;
    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
      ...(Object.keys(requestInit).length > 0 ? { requestInit } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.authProvider
        ? { authProvider: this.options.authProvider }
        : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    const client = new Client(MCP_CLIENT_INFO, {
      capabilities: {},
    });

    this.transport = transport;

    try {
      await this.wrapAuth(client.connect(transport));
      this.client = client;
      await this.syncTransportSessionId();
      return client;
    } catch (error) {
      await this.syncTransportSessionId();
      await this.disposeClient();
      throw error;
    }
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
      throw error;
    }
  }

  private async shouldResetMissingSession(error: unknown): Promise<boolean> {
    if (
      !(
        error instanceof StreamableHTTPError &&
        (error.code === 404 || /Session not found/i.test(error.message))
      )
    ) {
      return false;
    }

    return Boolean(
      this.transport?.sessionId ??
      this.lastAttemptedTransportSessionId ??
      (await this.getStoredTransportSessionId()),
    );
  }

  private async disposeClient(): Promise<void> {
    const transport = this.transport;
    this.listedTools = undefined;
    this.transport = undefined;
    this.client = undefined;

    if (transport) {
      await transport.close();
    }
  }

  private async getStoredTransportSessionId(): Promise<string | undefined> {
    const provider = this.options.authProvider as
      | HostManagedSessionProvider
      | undefined;
    return await provider?.getMcpServerSessionId?.();
  }

  private async clearStoredTransportSessionId(): Promise<void> {
    const provider = this.options.authProvider as
      | HostManagedSessionProvider
      | undefined;
    this.lastAttemptedTransportSessionId = undefined;
    await provider?.saveMcpServerSessionId?.(undefined);
  }

  private async syncTransportSessionId(): Promise<void> {
    const provider = this.options.authProvider as
      | HostManagedSessionProvider
      | undefined;
    const sessionId = this.transport?.sessionId;
    if (!provider?.saveMcpServerSessionId || !sessionId) {
      return;
    }
    this.lastAttemptedTransportSessionId = sessionId;
    await provider.saveMcpServerSessionId(sessionId);
  }
}

export type {
  ListedTool as PluginMcpListedTool,
  ToolCallResult as PluginMcpToolCallResult,
};
