import type { PluginMcpToolSuccess } from "@sentry/junior-plugin-api";

/** Join the text parts returned by a Linear MCP tool call. */
export function linearProviderText(result: PluginMcpToolSuccess): string {
  return result.content
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}
