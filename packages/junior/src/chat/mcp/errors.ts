/** Thrown when an MCP tool returns an error result. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/** Return the OpenTelemetry error.type value for MCP-aware tool failures. */
export function getMcpAwareErrorType(error: unknown, fallback: string): string {
  if (error instanceof McpToolError) {
    return "tool_error";
  }
  return error instanceof Error ? error.name : fallback;
}

/** Return the display-safe error message for MCP-aware tool failures. */
export function getMcpAwareErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
