import { gateway } from "@ai-sdk/gateway";

export function createWebSearchTool() {
  return gateway.tools.parallelSearch({
    mode: "agentic"
  });
}
