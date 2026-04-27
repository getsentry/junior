import type { ManagedMcpToolDescriptor } from "@/chat/mcp/tool-manager";

export interface ExposedToolSummary {
  tool_name: string;
  mcp_tool_name: string;
  provider: string;
  description: string;
  input_schema: Record<string, unknown>;
  input_schema_summary: string;
}

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

export function toExposedToolSummary(
  toolDef: ManagedMcpToolDescriptor,
): ExposedToolSummary {
  return {
    tool_name: toolDef.name,
    mcp_tool_name: toolDef.rawName,
    provider: toolDef.provider,
    description: toolDef.description,
    input_schema: toolDef.parameters,
    input_schema_summary: summarizeInputSchema(toolDef.parameters),
  };
}
