/** Extract the provider from canonical `mcp__<provider>__<tool>` names. */
export function parseMcpProviderFromToolName(
  toolName: string,
): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const afterPrefix = toolName.slice("mcp__".length);
  const delimiterIndex = afterPrefix.indexOf("__");
  return delimiterIndex > 0 ? afterPrefix.slice(0, delimiterIndex) : undefined;
}

/** Format an MCP provider id, such as `linear`, for progress text. */
export function mcpProviderLabel(provider: string): string {
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}
