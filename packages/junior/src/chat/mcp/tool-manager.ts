import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { SkillMetadata } from "@/chat/skills";
import type { PluginDefinition } from "@/chat/plugins/types";
import {
  McpAuthorizationRequiredError,
  PluginMcpClient,
  type PluginMcpListedTool,
  type PluginMcpToolCallResult,
} from "./client";

function normalizeMcpToolName(provider: string, toolName: string): string {
  return `mcp__${provider}__${toolName}`;
}

function summarizeStructuredContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return JSON.stringify(value, null, 2);
}

function summarizeResourcePart(part: {
  type: "resource";
  resource:
    | { uri: string; text: string; mimeType?: string }
    | { uri: string; blob: string; mimeType?: string };
}): string {
  if ("text" in part.resource) {
    return part.resource.text;
  }

  return [
    `Resource: ${part.resource.uri}`,
    ...(part.resource.mimeType ? [`Mime Type: ${part.resource.mimeType}`] : []),
    `Blob bytes (base64): ${part.resource.blob.length}`,
  ].join("\n");
}

function toAgentToolContent(
  result: PluginMcpToolCallResult,
): Array<TextContent | ImageContent> {
  if ("toolResult" in result) {
    return [
      {
        type: "text",
        text: JSON.stringify(result.toolResult, null, 2),
      },
    ];
  }

  const content: Array<TextContent | ImageContent> = [];

  for (const part of result.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      content.push({
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      });
      continue;
    }
    if (part.type === "audio") {
      content.push({
        type: "text",
        text: `Audio output (${part.mimeType}, ${part.data.length} base64 chars)`,
      });
      continue;
    }
    if (part.type === "resource_link") {
      content.push({
        type: "text",
        text: part.uri,
      });
      continue;
    }
    content.push({
      type: "text",
      text: summarizeResourcePart(part),
    });
  }

  if (content.length > 0) {
    return content;
  }

  const structured = summarizeStructuredContent(result.structuredContent);
  if (structured) {
    return [{ type: "text", text: structured }];
  }

  return [{ type: "text", text: "ok" }];
}

function describeMcpTool(provider: string, tool: PluginMcpListedTool): string {
  const prefix = `[${provider}]`;
  const details = tool.description?.trim() || tool.title?.trim() || tool.name;
  return `${prefix} ${details}`;
}

function extractMcpErrorMessage(result: PluginMcpToolCallResult): string {
  if ("toolResult" in result) {
    return JSON.stringify(result.toolResult, null, 2);
  }

  const textParts = result.content
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0);
  if (textParts.length > 0) {
    return textParts.join("\n\n");
  }

  const structured = summarizeStructuredContent(result.structuredContent);
  if (structured) {
    return structured;
  }

  return "MCP tool call failed";
}

export interface McpToolManagerOptions {
  authProviderFactory?: (
    plugin: PluginDefinition,
  ) =>
    | OAuthClientProvider
    | undefined
    | Promise<OAuthClientProvider | undefined>;
  fetch?: typeof fetch;
  onAuthorizationRequired?: (
    provider: string,
    error: McpAuthorizationRequiredError,
  ) => Promise<void> | void;
  sessionId?: string;
}

export class McpToolManager {
  private readonly pluginsByProvider = new Map<string, PluginDefinition>();
  private readonly activeProviders = new Set<string>();
  private readonly clientsByProvider = new Map<string, PluginMcpClient>();
  private readonly toolsByProvider = new Map<string, AgentTool<any>[]>();

  constructor(
    plugins: PluginDefinition[],
    private readonly options: McpToolManagerOptions = {},
  ) {
    for (const plugin of plugins) {
      if (plugin.manifest.mcp) {
        this.pluginsByProvider.set(plugin.manifest.name, plugin);
      }
    }
  }

  getActiveProviders(): string[] {
    return [...this.activeProviders].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  getActiveTools(): AgentTool<any>[] {
    return this.getActiveProviders().flatMap(
      (provider) => this.toolsByProvider.get(provider) ?? [],
    );
  }

  async activateForSkill(
    skill: Pick<SkillMetadata, "pluginProvider">,
  ): Promise<boolean> {
    if (!skill.pluginProvider) {
      return false;
    }

    return await this.activateProvider(skill.pluginProvider);
  }

  async activateProvider(provider: string): Promise<boolean> {
    if (this.activeProviders.has(provider)) {
      return false;
    }

    const plugin = this.pluginsByProvider.get(provider);
    if (!plugin?.manifest.mcp) {
      return false;
    }

    const client = await this.getClient(plugin);

    try {
      const tools = await client.listTools();
      this.toolsByProvider.set(
        provider,
        tools.map((tool) => this.toAgentTool(plugin, client, tool)),
      );
      this.activeProviders.add(provider);
      return true;
    } catch (error) {
      if (
        error instanceof McpAuthorizationRequiredError &&
        this.options.onAuthorizationRequired
      ) {
        await this.options.onAuthorizationRequired(plugin.manifest.name, error);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    let firstError: unknown;

    for (const client of this.clientsByProvider.values()) {
      try {
        await client.close();
      } catch (error) {
        firstError ??= error;
      }
    }

    this.clientsByProvider.clear();
    this.toolsByProvider.clear();
    this.activeProviders.clear();

    if (firstError) {
      throw firstError;
    }
  }

  private async getClient(plugin: PluginDefinition): Promise<PluginMcpClient> {
    const existing = this.clientsByProvider.get(plugin.manifest.name);
    if (existing) {
      return existing;
    }

    const authProvider = this.options.authProviderFactory
      ? await this.options.authProviderFactory(plugin)
      : undefined;
    const client = new PluginMcpClient(plugin, {
      ...(authProvider ? { authProvider } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    });
    this.clientsByProvider.set(plugin.manifest.name, client);
    return client;
  }

  private toAgentTool(
    plugin: PluginDefinition,
    client: PluginMcpClient,
    tool: PluginMcpListedTool,
  ): AgentTool<TSchema> {
    return {
      name: normalizeMcpToolName(plugin.manifest.name, tool.name),
      label: tool.title?.trim() || tool.name,
      description: describeMcpTool(plugin.manifest.name, tool),
      parameters: tool.inputSchema as unknown as TSchema,
      execute: async (_toolCallId, params) => {
        const args =
          typeof params === "object" && params !== null
            ? (params as Record<string, unknown>)
            : {};

        try {
          const result = await client.callTool(tool.name, args);
          if ("isError" in result && result.isError) {
            throw new Error(extractMcpErrorMessage(result));
          }

          return {
            content: toAgentToolContent(result),
            details: {
              provider: plugin.manifest.name,
              tool: tool.name,
              rawResult: result,
            },
          };
        } catch (error) {
          if (
            error instanceof McpAuthorizationRequiredError &&
            this.options.onAuthorizationRequired
          ) {
            await this.options.onAuthorizationRequired(
              plugin.manifest.name,
              error,
            );
          }
          throw error;
        }
      },
    };
  }
}
