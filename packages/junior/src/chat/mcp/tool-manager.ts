import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
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
}

export interface ManagedMcpToolResult {
  content: Array<TextContent | ImageContent>;
  details: {
    provider: string;
    tool: string;
    rawResult: PluginMcpToolCallResult;
  };
}

export interface ManagedMcpToolDescriptor {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  provider: string;
  rawName: string;
  title?: string;
}

interface ManagedMcpTool extends ManagedMcpToolDescriptor {
  execute: (args: Record<string, unknown>) => Promise<ManagedMcpToolResult>;
}

export class McpToolManager {
  private readonly pluginsByProvider = new Map<string, PluginDefinition>();
  private readonly activeProviders = new Set<string>();
  private readonly clientsByProvider = new Map<string, PluginMcpClient>();
  private readonly toolsByProvider = new Map<string, ManagedMcpTool[]>();

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

  async activateForSkill(
    skill: Pick<SkillMetadata, "name" | "pluginProvider" | "allowedMcpTools">,
  ): Promise<boolean> {
    if (!skill.pluginProvider) {
      return false;
    }

    const activated = await this.activateProvider(skill.pluginProvider);
    this.assertSkillToolExposure(skill);
    return activated;
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
      const tools = this.filterListedTools(plugin, await client.listTools());
      this.toolsByProvider.set(
        provider,
        tools.map((tool) => this.toManagedTool(plugin, client, tool)),
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

  getActiveToolCatalog(
    skills: Array<Pick<SkillMetadata, "pluginProvider" | "allowedMcpTools">>,
    options: { provider?: string } = {},
  ): ManagedMcpToolDescriptor[] {
    return this.getResolvedActiveTools(skills, options).map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      provider: tool.provider,
      rawName: tool.rawName,
      ...(tool.title ? { title: tool.title } : {}),
    }));
  }

  searchTools(
    skills: Array<Pick<SkillMetadata, "pluginProvider" | "allowedMcpTools">>,
    query: string,
    options: { provider?: string; limit?: number } = {},
  ): ManagedMcpToolDescriptor[] {
    const resolved = this.getActiveToolCatalog(skills, options);
    const trimmedQuery = query.trim();
    if (!trimmedQuery || trimmedQuery === "*") {
      return resolved.slice(0, Math.max(1, options.limit ?? 8));
    }

    const normalizedQuery = trimmedQuery.toLowerCase();
    const queryTokens = normalizedQuery
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    return resolved
      .map((tool) => ({
        tool,
        score: this.scoreToolMatch(tool, normalizedQuery, queryTokens),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.tool.name.localeCompare(right.tool.name);
      })
      .slice(0, Math.max(1, options.limit ?? 8))
      .map((entry) => entry.tool);
  }

  async executeTool(
    skills: Array<Pick<SkillMetadata, "pluginProvider" | "allowedMcpTools">>,
    canonicalToolName: string,
    args: Record<string, unknown>,
  ): Promise<ManagedMcpToolResult> {
    const tool = this.resolveActiveTool(skills, canonicalToolName);
    if (!tool) {
      throw new Error(`Unknown active MCP tool: ${canonicalToolName}`);
    }

    return await tool.execute(args);
  }

  private filterListedTools(
    plugin: PluginDefinition,
    tools: PluginMcpListedTool[],
  ): PluginMcpListedTool[] {
    const allowedTools = plugin.manifest.mcp?.allowedTools;
    if (!allowedTools || allowedTools.length === 0) {
      return tools;
    }

    const availableToolNames = new Set(tools.map((tool) => tool.name));
    const missingTools = allowedTools.filter(
      (toolName) => !availableToolNames.has(toolName),
    );
    if (missingTools.length > 0) {
      throw new Error(
        `Plugin ${plugin.manifest.name} MCP discovery missing allowlisted tools: ${missingTools.join(", ")}`,
      );
    }

    const allowedToolSet = new Set(allowedTools);
    return tools.filter((tool) => allowedToolSet.has(tool.name));
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
    });
    this.clientsByProvider.set(plugin.manifest.name, client);
    return client;
  }

  private toManagedTool(
    plugin: PluginDefinition,
    client: PluginMcpClient,
    tool: PluginMcpListedTool,
  ): ManagedMcpTool {
    return {
      name: normalizeMcpToolName(plugin.manifest.name, tool.name),
      label: tool.title?.trim() || tool.name,
      description: describeMcpTool(plugin.manifest.name, tool),
      parameters: tool.inputSchema as Record<string, unknown>,
      provider: plugin.manifest.name,
      rawName: tool.name,
      ...(tool.title?.trim() ? { title: tool.title.trim() } : {}),
      execute: async (args) => {
        const resolvedArgs =
          typeof args === "object" && args !== null ? args : {};

        try {
          const result = await client.callTool(tool.name, resolvedArgs);
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

  private assertSkillToolExposure(
    skill: Pick<SkillMetadata, "name" | "pluginProvider" | "allowedMcpTools">,
  ): void {
    const provider = skill.pluginProvider;
    if (
      !provider ||
      !skill.allowedMcpTools ||
      skill.allowedMcpTools.length === 0
    ) {
      return;
    }

    const availableToolNames = new Set(
      (this.toolsByProvider.get(provider) ?? []).map((tool) => tool.rawName),
    );
    const missingTools = skill.allowedMcpTools.filter(
      (toolName) => !availableToolNames.has(toolName),
    );
    if (missingTools.length > 0) {
      throw new Error(
        `Skill ${skill.name} declares unavailable MCP tools for plugin ${provider}: ${missingTools.join(", ")}`,
      );
    }
  }

  private getResolvedActiveTools(
    skills: Array<Pick<SkillMetadata, "pluginProvider" | "allowedMcpTools">>,
    options: { provider?: string } = {},
  ): ManagedMcpTool[] {
    const resolved: ManagedMcpTool[] = [];

    for (const provider of this.getActiveProviders()) {
      if (options.provider && provider !== options.provider) {
        continue;
      }

      resolved.push(...this.resolveProviderTools(provider, skills));
    }

    return resolved;
  }

  private resolveProviderTools(
    provider: string,
    skills: Array<Pick<SkillMetadata, "pluginProvider" | "allowedMcpTools">>,
  ): ManagedMcpTool[] {
    const providerTools = this.toolsByProvider.get(provider) ?? [];
    if (providerTools.length === 0) {
      return [];
    }

    const relevantSkills = skills.filter(
      (skill) => skill.pluginProvider === provider,
    );
    if (relevantSkills.length === 0) {
      return [];
    }

    const exposeAllProviderTools = relevantSkills.some(
      (skill) => !skill.allowedMcpTools || skill.allowedMcpTools.length === 0,
    );
    if (exposeAllProviderTools) {
      return providerTools;
    }

    const allowedToolNames = new Set(
      relevantSkills.flatMap((skill) => skill.allowedMcpTools ?? []),
    );
    return providerTools.filter((tool) => allowedToolNames.has(tool.rawName));
  }

  private resolveActiveTool(
    skills: Array<Pick<SkillMetadata, "pluginProvider" | "allowedMcpTools">>,
    canonicalToolName: string,
  ): ManagedMcpTool | undefined {
    return this.getResolvedActiveTools(skills).find(
      (tool) => tool.name === canonicalToolName,
    );
  }

  private scoreToolMatch(
    tool: ManagedMcpToolDescriptor,
    normalizedQuery: string,
    queryTokens: string[],
  ): number {
    const exactCandidates = [tool.name, tool.rawName, tool.label, tool.title]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());

    if (exactCandidates.includes(normalizedQuery)) {
      return 100;
    }

    let score = 0;
    const searchableText = [
      tool.name,
      tool.rawName,
      tool.label,
      tool.title,
      tool.description,
      tool.provider,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase();

    for (const candidate of exactCandidates) {
      if (candidate.startsWith(normalizedQuery)) {
        score = Math.max(score, 60);
      }
    }

    for (const token of queryTokens) {
      if (searchableText.includes(token)) {
        score += 10;
      }
    }

    return score;
  }
}
