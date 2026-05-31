import type { ManagedMcpToolDescriptor } from "@/chat/mcp/tool-manager";

export interface ExposedToolSummary {
  tool_name: string;
  mcp_tool_name: string;
  provider: string;
  title?: string;
  description: string;
  signature: string;
  call: {
    tool_name: string;
    arguments: Record<string, string>;
  };
  input_schema: Record<string, unknown>;
  input_schema_summary: string;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ActiveMcpCatalogSummary {
  provider: string;
  available_tool_count: number;
}

function getSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return schema.properties && typeof schema.properties === "object"
    ? (schema.properties as Record<string, unknown>)
    : {};
}

function getRequiredFields(schema: Record<string, unknown>): Set<string> {
  return Array.isArray(schema.required)
    ? new Set(
        schema.required.filter(
          (value): value is string => typeof value === "string",
        ),
      )
    : new Set<string>();
}

function formatSchemaType(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  const typed = schema as Record<string, unknown>;
  const type = typed.type;
  if (typeof type === "string") {
    if (type === "array") {
      return `${formatSchemaType(typed.items)}[]`;
    }
    return type;
  }
  if (Array.isArray(type)) {
    return type.filter((value) => typeof value === "string").join(" | ");
  }
  if (Array.isArray(typed.enum) && typed.enum.length > 0) {
    return typed.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  return "unknown";
}

function formatArgumentPlaceholder(name: string, schema: unknown): string {
  const type = formatSchemaType(schema);
  if (type === "string") {
    return `<${name}>`;
  }
  if (type === "number" || type === "integer") {
    return "<number>";
  }
  if (type === "boolean") {
    return "<boolean>";
  }
  if (type.endsWith("[]")) {
    return "<array>";
  }
  if (type === "object") {
    return "<object>";
  }
  return `<${type}>`;
}

/** Build a stable model-readable MCP tool signature. */
export function formatMcpToolSignature(
  toolName: string,
  schema: Record<string, unknown>,
): string {
  const properties = getSchemaProperties(schema);
  const required = getRequiredFields(schema);
  const fields = Object.entries(properties).map(([name, propertySchema]) => {
    const marker = required.has(name) ? "" : "?";
    return `${name}${marker}: ${formatSchemaType(propertySchema)}`;
  });
  if (fields.length === 0) {
    return `${toolName}()`;
  }
  return `${toolName}({ ${fields.join(", ")} })`;
}

/** Build the exact callMcpTool argument shape agents should use. */
export function formatMcpToolCallExample(
  toolName: string,
  schema: Record<string, unknown>,
): ExposedToolSummary["call"] {
  return {
    tool_name: toolName,
    arguments: Object.fromEntries(
      Object.entries(getSchemaProperties(schema)).map(
        ([name, propertySchema]) => [
          name,
          formatArgumentPlaceholder(name, propertySchema),
        ],
      ),
    ),
  };
}

/** Summarize an MCP input schema for quick catalog scanning. */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  const properties = getSchemaProperties(schema);
  const required = getRequiredFields(schema);
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
    signature: formatMcpToolSignature(toolDef.name, toolDef.parameters),
    call: formatMcpToolCallExample(toolDef.name, toolDef.parameters),
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
