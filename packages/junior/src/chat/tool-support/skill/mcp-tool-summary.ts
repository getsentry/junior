import type { ManagedMcpToolDescriptor } from "@/chat/mcp/tool-manager";

/** Agent-visible MCP tool descriptor with the provider schema as its argument contract. */
export interface ExposedToolSummary {
  tool_name: string;
  mcp_tool_name: string;
  provider: string;
  title?: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ActiveMcpCatalogSummary {
  provider: string;
  available_tool_count: number;
}

/** Convert a managed MCP tool descriptor into agent-visible search output. */
export function toExposedToolSummary(
  toolDef: ManagedMcpToolDescriptor,
): ExposedToolSummary {
  return {
    tool_name: toolDef.name,
    mcp_tool_name: toolDef.rawName,
    provider: toolDef.provider,
    ...(toolDef.title ? { title: toolDef.title } : undefined),
    description: toolDef.description,
    input_schema: toolDef.parameters,
    ...(toolDef.outputSchema ? { output_schema: toolDef.outputSchema } : undefined),
    ...(toolDef.annotations ? { annotations: toolDef.annotations } : undefined),
  };
}

/** Group discovered MCP tools into provider catalogs for prompt disclosure. */
export function toActiveMcpCatalogSummaries(
  toolDefs: ManagedMcpToolDescriptor[],
): ActiveMcpCatalogSummary[] {
  const countsByProvider = new Map<string, number>();
  for (const toolDef of toolDefs) {
    countsByProvider.set(
      toolDef.provider,
      (countsByProvider.get(toolDef.provider) ?? 0) + 1,
    );
  }

  return [...countsByProvider.entries()]
    .map(([provider, availableToolCount]) => ({
      provider,
      available_tool_count: availableToolCount,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}
