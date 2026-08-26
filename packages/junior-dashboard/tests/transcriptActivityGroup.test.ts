import { describe, expect, it } from "vitest";

import {
  activityGroupLabel,
  activityGroupOpen,
  activityGroupSummary,
  isCollapsibleActivityEntry,
} from "../src/client/conversations/TranscriptActivityGroup";
import type { RenderedTranscriptEntry } from "../src/client/conversations/transcriptRenderModel";

function tool(
  id: string,
  status: "running" | "completed" | "error" = "completed",
  times?: {
    resultTimestamp?: number;
    startedTimestamp?: number;
    timestamp?: number;
  },
): RenderedTranscriptEntry {
  return {
    key: `tool:${id}`,
    kind: "tool",
    part: {
      id,
      input: {},
      name: "bash",
      resultTimestamp: times?.resultTimestamp,
      startedTimestamp: times?.startedTimestamp,
      status,
      type: "tool_call",
    },
    timestamp: times?.timestamp ?? times?.startedTimestamp ?? 1,
  };
}

function subagent(
  id: string,
  status: "aborted" | "completed" | "error" | "running" = "completed",
): RenderedTranscriptEntry {
  return {
    key: `subagent:${id}`,
    kind: "subagent",
    part: {
      childConversationId: `child:${id}`,
      id,
      status,
      subagentKind: "explore",
      type: "subagent",
    },
    timestamp: 1,
  };
}

function reasoning(key: string): RenderedTranscriptEntry {
  return {
    key,
    kind: "reasoning",
    part: { text: "thinking", type: "reasoning" },
    timestamp: 1,
  };
}

function compaction(): RenderedTranscriptEntry {
  return {
    key: "context:1",
    kind: "context",
    part: {
      event: {
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "compaction",
      },
      type: "context_event",
    },
    timestamp: 1,
  };
}

function handoff(): RenderedTranscriptEntry {
  return {
    key: "context:2",
    kind: "context",
    part: {
      event: {
        createdAt: "2026-01-01T00:00:00.000Z",
        modelId: "openai/gpt-5-mini",
        modelProfile: "fast",
        type: "handoff",
      },
      type: "context_event",
    },
    timestamp: 1,
  };
}

function message(): RenderedTranscriptEntry {
  return {
    key: "message:1",
    kind: "message",
    message: {
      parts: [{ text: "hello", type: "text" }],
      role: "user",
      sourceSeq: 1,
    },
  };
}

function failure(): RenderedTranscriptEntry {
  return {
    key: "failure:1",
    kind: "failure",
    failureCode: "model_execution_failed",
    timestamp: 1,
  };
}

describe("transcript activity group", () => {
  it("stays collapsed until the reader explicitly opens it", () => {
    expect(activityGroupOpen(null)).toBe(false);
    expect(activityGroupOpen(true)).toBe(true);
    expect(activityGroupOpen(false)).toBe(false);
  });

  it("collapses non-message activity including tool errors, and keeps failures and chat messages open", () => {
    expect(isCollapsibleActivityEntry(tool("1"))).toBe(true);
    expect(isCollapsibleActivityEntry(tool("err", "error"))).toBe(true);
    expect(isCollapsibleActivityEntry(subagent("ok"))).toBe(true);
    expect(isCollapsibleActivityEntry(subagent("err", "error"))).toBe(true);
    expect(isCollapsibleActivityEntry(subagent("stop", "aborted"))).toBe(true);
    expect(isCollapsibleActivityEntry(reasoning("r1"))).toBe(true);
    expect(isCollapsibleActivityEntry(compaction())).toBe(true);
    expect(isCollapsibleActivityEntry(handoff())).toBe(true);
    expect(isCollapsibleActivityEntry(message())).toBe(false);
    expect(isCollapsibleActivityEntry(failure())).toBe(false);
  });

  it("uses a uniform event count for collapsed activity labels", () => {
    expect(activityGroupLabel([tool("1")])).toBe("1 event");
    expect(activityGroupLabel([tool("1"), tool("2")])).toBe("2 events");
    expect(activityGroupLabel([reasoning("r1")])).toBe("1 event");
    expect(activityGroupLabel([tool("1"), reasoning("r1")])).toBe("2 events");
    expect(
      activityGroupLabel([tool("1"), tool("2"), compaction(), handoff()]),
    ).toBe("4 events");
  });

  it("appends group duration when start and end timestamps are known", () => {
    expect(
      activityGroupLabel([
        tool("1", "completed", {
          startedTimestamp: 1_000,
          resultTimestamp: 1_800,
          timestamp: 1_000,
        }),
        tool("2", "completed", {
          startedTimestamp: 1_200,
          resultTimestamp: 2_100,
          timestamp: 1_200,
        }),
      ]),
    ).toBe("2 events · 1.1s");
    expect(
      activityGroupLabel([
        tool("1", "completed", {
          startedTimestamp: 500,
          resultTimestamp: 800,
          timestamp: 500,
        }),
      ]),
    ).toBe("1 event · 300ms");
  });

  it("summarizes collapsed activity contents for the tooltip", () => {
    expect(activityGroupSummary([tool("1")])).toBe("1 tool call");
    expect(activityGroupSummary([tool("1"), reasoning("r1")])).toBe(
      "1 tool call · 1 reasoning entry",
    );
    expect(
      activityGroupSummary([tool("1"), tool("2"), compaction(), handoff()]),
    ).toBe("2 tool calls · context compacted · model handoff");
    expect(activityGroupSummary([compaction()])).toBe("context compacted");
    expect(activityGroupSummary([handoff()])).toBe("model handoff");
  });
});
