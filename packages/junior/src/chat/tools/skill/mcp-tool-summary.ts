import type { ManagedMcpToolDescriptor } from "@/chat/mcp/tool-manager";

export interface ExposedToolSummary {
  tool_name: string;
  mcp_tool_name: string;
  provider: string;
  title?: string;
  description: string;
  input_schema: Record<string, unknown>;
  input_schema_summary: string;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ActiveMcpCatalogSummary {
  provider: string;
  available_tool_count: number;
}

/** Summarize an MCP input schema for quick catalog scanning. */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? new Set(
        schema.required.filter(
          (value): value is string => typeof value === "string",
        ),
      )
    : new Set<string>();
  const propertyNames = Object.keys(properties);
  if (propertyNames.length === 0) {
    return "No arguments.";
  }

  return propertyNames
    .map((name) => `${name}${required.has(name) ? " (required)" : ""}`)
    .join(", ");
}

/** Convert a managed MCP tool descriptor into agent-visible search output. */
export function toExposedToolSummary(
  toolDef: ManagedMcpToolDescriptor,
): ExposedToolSummary {
  return {
    tool_name: toolDef.name,
    mcp_tool_name: toolDef.rawName,
    provider: toolDef.provider,
    ...(toolDef.title ? { title: toolDef.title } : {}),
    description: toolDef.description,
    input_schema: toolDef.parameters,
    input_schema_summary: summarizeInputSchema(toolDef.parameters),
    ...(toolDef.outputSchema ? { output_schema: toolDef.outputSchema } : {}),
    ...(toolDef.annotations ? { annotations: toolDef.annotations } : {}),
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
