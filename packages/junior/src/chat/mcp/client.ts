import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setSpanAttributes } from "@/chat/logging";
import { fetchWithBoundedOAuthErrorBodies } from "@/chat/oauth-response";
import type { PluginDefinition } from "@/chat/plugins/types";
import {
  McpProviderError,
  type McpProviderErrorPhase,
  toMcpProviderError,
} from "./errors";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const MCP_CLIENT_INFO = {
  name: "junior-mcp-client",
  version: "1.0.0",
};
const MCP_TOOLS_CALL_METHOD = "tools/call";

function getDefaultPort(url: URL): number | undefined {
  if (url.protocol === "https:") {
    return 443;
  }
  if (url.protocol === "http:") {
    return 80;
  }
  return undefined;
}

function getMcpNetworkAttributes(url: URL): Record<string, string | number> {
  const port = url.port ? Number(url.port) : getDefaultPort(url);
  return {
    "server.address": url.hostname,
    ...(port !== undefined ? { "server.port": port } : undefined),
    ...(url.protocol === "http:" || url.protocol === "https:"
      ? {
          "network.protocol.name": "http",
          "network.transport": "tcp",
        }
      : undefined),
  };
}

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

function isMissingSessionError(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    (error.code === 404 || /Session not found/i.test(error.message))
  );
}

export class PluginMcpClient {
  private client?: Client;
  private clientPromise?: Promise<Client>;
  private lastAttemptedTransportSessionId?: string;
  private readonly providerStatusStore = new AsyncLocalStorage<{
    status?: number;
  }>();
  private transport?: StreamableHTTPClientTransport;
  private listedTools?: ListedTool[];
  private readonly resourceHost?: string;

  constructor(
    private readonly plugin: PluginDefinition,
    private readonly options: PluginMcpClientOptions = {},
  ) {
    const url = plugin.manifest.mcp?.url;
    this.resourceHost = url ? new URL(url).hostname : undefined;
  }

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
          () => client.listTools(cursor ? { cursor } : undefined),
          "list_tools",
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
      const mcp = this.plugin.manifest.mcp;
      if (mcp) {
        const url = new URL(mcp.url);
        setSpanAttributes({
          "mcp.method.name": MCP_TOOLS_CALL_METHOD,
          "gen_ai.operation.name": "execute_tool",
          ...(this.transport?.sessionId
            ? { "mcp.session.id": this.transport.sessionId }
            : undefined),
          ...(this.transport?.protocolVersion
            ? { "mcp.protocol.version": this.transport.protocolVersion }
            : undefined),
          ...getMcpNetworkAttributes(url),
        });
      }
      const result = await this.wrapAuth(
        () =>
          client.callTool({
            name,
            arguments: args ?? {},
          }),
        "call_tool",
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
      await this.cleanupClientAfterFailure();
      return await operation();
    }
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    if (this.clientPromise) {
      return await this.clientPromise;
    }

    const clientPromise = this.connectClient();
    this.clientPromise = clientPromise;
    try {
      return await clientPromise;
    } finally {
      if (this.clientPromise === clientPromise) {
        this.clientPromise = undefined;
      }
    }
  }

  private async connectClient(): Promise<Client> {
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
      ...(Object.keys(requestInit).length > 0 ? { requestInit } : undefined),
      fetch: fetchWithBoundedOAuthErrorBodies(this.options.fetch, (status) => {
        const store = this.providerStatusStore.getStore();
        if (store) {
          store.status = status;
        }
      }),
      ...(this.options.authProvider
        ? { authProvider: this.options.authProvider }
        : undefined),
      ...(sessionId ? { sessionId } : undefined),
    });
    const client = new Client(MCP_CLIENT_INFO, {
      capabilities: {},
    });

    this.transport = transport;

    try {
      await this.wrapAuth(() => client.connect(transport), "connect");
      this.client = client;
      await this.syncTransportSessionId();
      return client;
    } catch (error) {
      await this.syncTransportSessionId();
      await this.cleanupClientAfterFailure();
      throw error;
    }
  }

  private async wrapAuth<T>(
    operation: () => Promise<T>,
    phase: McpProviderErrorPhase,
  ): Promise<T> {
    const store: { status?: number } = {};
    return await this.providerStatusStore.run(store, async () => {
      try {
        return await operation();
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
        throw toMcpProviderError(error, {
          phase,
          provider: this.plugin.manifest.name,
          missingSession: isMissingSessionError(error) || undefined,
          resourceHost: this.resourceHost,
          status: store.status,
        });
      }
    });
  }

  private async shouldResetMissingSession(error: unknown): Promise<boolean> {
    if (
      !(
        (error instanceof McpProviderError && error.missingSession) ||
        isMissingSessionError(error)
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

  private resetClientState(): StreamableHTTPClientTransport | undefined {
    const transport = this.transport;
    this.listedTools = undefined;
    this.transport = undefined;
    this.client = undefined;
    this.clientPromise = undefined;
    return transport;
  }

  private async cleanupClientAfterFailure(): Promise<void> {
    const transport = this.resetClientState();
    if (!transport) {
      return;
    }
    try {
      await transport.close();
    } catch {}
  }

  private async disposeClient(): Promise<void> {
    const transport = this.resetClientState();

    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        throw toMcpProviderError(error, {
          phase: "close",
          provider: this.plugin.manifest.name,
          resourceHost: this.resourceHost,
        });
      }
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
