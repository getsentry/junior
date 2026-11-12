import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Counts of the assistant messages in one Run that had two or more tool calls. */
export interface ToolBatchStats {
  count: number;
  sequentialCount: number;
  sequentialCallCount: number;
  sequentialToolNames: Set<string>;
}

/** Start the batch counts for one Run. */
export function createToolBatchStats(): ToolBatchStats {
  return {
    count: 0,
    sequentialCount: 0,
    sequentialCallCount: 0,
    sequentialToolNames: new Set(),
  };
}

/**
 * Count one batch of tool calls. Pi runs them in parallel unless one of their
 * tools is `sequential`; then it runs all of them one at a time.
 */
export function recordToolBatch(
  stats: ToolBatchStats,
  toolCalls: ReadonlyArray<{ name: string }>,
  tools: ReadonlyArray<Pick<AgentTool, "executionMode" | "name">>,
): void {
  const sequentialTools = toolCalls
    .map((call) => call.name)
    .filter(
      (name) =>
        tools.find((tool) => tool.name === name)?.executionMode ===
        "sequential",
    );
  stats.count += 1;
  if (sequentialTools.length === 0) {
    return;
  }
  stats.sequentialCount += 1;
  stats.sequentialCallCount += toolCalls.length;
  for (const name of sequentialTools) {
    stats.sequentialToolNames.add(name);
  }
}

/**
 * Span attributes for the batch counts of one Run, set on its
 * `gen_ai.invoke_agent` span because production drops info logs.
 */
export function toolBatchSpanAttributes(
  stats: ToolBatchStats,
): Record<string, unknown> {
  return {
    "app.tool_batch.count": stats.count,
    "app.tool_batch.sequential_count": stats.sequentialCount,
    "app.tool_batch.sequential_call_count": stats.sequentialCallCount,
    "app.tool_batch.sequential_tool_names": [...stats.sequentialToolNames]
      .sort()
      .join(","),
  };
}
