import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logInfo } from "@/chat/logging";

/**
 * Record how Pi runs the tool calls of one assistant message. Pi runs them
 * in parallel unless one of their tools is `sequential`; then it runs all of
 * them one at a time.
 */
export function logToolBatch(
  toolCalls: ReadonlyArray<{ name: string }>,
  tools: ReadonlyArray<Pick<AgentTool, "executionMode" | "name">>,
): void {
  const names = toolCalls.map((call) => call.name);
  const sequentialTools = [...new Set(names)]
    .filter(
      (name) =>
        tools.find((tool) => tool.name === name)?.executionMode ===
        "sequential",
    )
    .sort();
  logInfo("agent.tool_batch.started", {
    "app.tool_batch.size": toolCalls.length,
    "app.tool_batch.execution":
      sequentialTools.length > 0 ? "sequential" : "parallel",
    "app.tool_batch.tool_names": names,
    "app.tool_batch.sequential_tool_names": sequentialTools,
  });
}
