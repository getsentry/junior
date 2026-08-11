import { describe, expect, it } from "vitest";

import {
  activityGroupLabel,
  activityGroupOpen,
  isCollapsibleActivityEntry,
} from "../src/client/conversations/TranscriptActivityGroup";
import type { RenderedTranscriptEntry } from "../src/client/conversations/transcriptRenderModel";

function tool(
  id: string,
  status: "running" | "completed" | "error" = "completed",
): RenderedTranscriptEntry {
  return {
    key: `tool:${id}`,
    kind: "tool",
    part: {
      id,
      input: {},
      name: "bash",
      status,
      type: "tool_call",
    },
    timestamp: 1,
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
    outcome: "error",
    timestamp: 1,
  };
}

describe("transcript activity group", () => {
  it("uses activity state until the user makes an explicit choice", () => {
    expect(
      activityGroupOpen({
        activeTail: false,
        hasLiveActivity: false,
        userOpen: null,
      }),
    ).toBe(false);
    expect(
      activityGroupOpen({
        activeTail: true,
        hasLiveActivity: false,
        userOpen: null,
      }),
    ).toBe(true);
    expect(
      activityGroupOpen({
        activeTail: false,
        hasLiveActivity: true,
        userOpen: null,
      }),
    ).toBe(true);
    expect(
      activityGroupOpen({
        activeTail: false,
        hasLiveActivity: false,
        userOpen: true,
      }),
    ).toBe(true);
    expect(
      activityGroupOpen({
        activeTail: true,
        hasLiveActivity: true,
        userOpen: false,
      }),
    ).toBe(false);
  });

  it("collapses non-message activity and keeps failures and chat messages open", () => {
    expect(isCollapsibleActivityEntry(tool("1"))).toBe(true);
    expect(isCollapsibleActivityEntry(tool("err", "error"))).toBe(false);
    expect(isCollapsibleActivityEntry(subagent("ok"))).toBe(true);
    expect(isCollapsibleActivityEntry(subagent("err", "error"))).toBe(false);
    expect(isCollapsibleActivityEntry(subagent("stop", "aborted"))).toBe(false);
    expect(isCollapsibleActivityEntry(reasoning("r1"))).toBe(true);
    expect(isCollapsibleActivityEntry(compaction())).toBe(true);
    expect(isCollapsibleActivityEntry(handoff())).toBe(true);
    expect(isCollapsibleActivityEntry(message())).toBe(false);
    expect(isCollapsibleActivityEntry(failure())).toBe(false);
  });

  it("labels pure tool and reasoning runs with the familiar counts", () => {
    expect(activityGroupLabel([tool("1")])).toBe("1 tool call");
    expect(activityGroupLabel([tool("1"), tool("2")])).toBe("2 tool calls");
    expect(activityGroupLabel([reasoning("r1")])).toBe("1 reasoning entry");
    expect(activityGroupLabel([tool("1"), reasoning("r1")])).toBe(
      "1 tool call and 1 reasoning entry",
    );
  });

  it("labels mixed activity groups with an action count and key highlights", () => {
    expect(
      activityGroupLabel([tool("1"), tool("2"), compaction(), handoff()]),
    ).toBe("4 actions · 2 tool calls · context compacted · model handoff");
    expect(activityGroupLabel([compaction()])).toBe("context compacted");
    expect(activityGroupLabel([handoff()])).toBe("model handoff");
  });
});
