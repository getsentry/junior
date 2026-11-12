import { describe, expect, it } from "vitest";

import {
  activityGroupLabel,
  activityGroupSummary,
  isCollapsibleActivityEntry,
  quietTurnEntryKeys,
} from "../src/client/conversations/TranscriptActivityGroup";
import { liveActivityStep } from "../src/client/conversations/TranscriptLiveStep";
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

function subagent(id: string): RenderedTranscriptEntry {
  return {
    key: `subagent:${id}`,
    kind: "subagent",
    part: {
      childConversationId: `child:${id}`,
      id,
      status: "completed",
      childKind: "task",
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

function message(eventType?: string): RenderedTranscriptEntry {
  return {
    key: "message:1",
    kind: "message",
    message: {
      parts: [{ text: "hello", type: "text" }],
      ...(eventType ? { eventType } : undefined),
      role: "user",
      sourceSeq: 1,
    },
  };
}

function turnMessage(
  key: string,
  role: "assistant" | "user",
  meta: { eventType?: string; noReply?: true; quiet?: true } = {},
): RenderedTranscriptEntry {
  return {
    key,
    kind: "message",
    message: {
      parts: [{ text: key, type: "text" }],
      ...meta,
      role,
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
  it("collapses non-message activity and agent invocation results, and keeps failures, subagents, and chat messages open", () => {
    expect(isCollapsibleActivityEntry(tool("1"))).toBe(true);
    expect(isCollapsibleActivityEntry(tool("err", "error"))).toBe(true);
    expect(isCollapsibleActivityEntry(subagent("ok"))).toBe(false);
    expect(isCollapsibleActivityEntry(reasoning("r1"))).toBe(true);
    expect(isCollapsibleActivityEntry(compaction())).toBe(true);
    expect(isCollapsibleActivityEntry(message())).toBe(false);
    expect(isCollapsibleActivityEntry(message("pull_request.opened"))).toBe(
      false,
    );
    expect(
      isCollapsibleActivityEntry(message("agent_invocation.completed")),
    ).toBe(true);
    expect(isCollapsibleActivityEntry(failure())).toBe(false);
  });

  it("uses a uniform event count for collapsed activity labels", () => {
    expect(activityGroupLabel([tool("1")])).toBe("1 event");
    expect(activityGroupLabel([tool("1"), tool("2")])).toBe("2 events");
    expect(activityGroupLabel([reasoning("r1")])).toBe("1 event");
    expect(activityGroupLabel([tool("1"), reasoning("r1")])).toBe("2 events");
    expect(activityGroupLabel([tool("1"), tool("2"), compaction()])).toBe(
      "3 events",
    );
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

  it("folds quiet replies and unanswered Event messages", () => {
    const entries = [
      turnMessage("person", "user"),
      turnMessage("loud-reply", "assistant"),
      turnMessage("deploy", "user", {
        eventType: "pull_request.comment.created",
        noReply: true,
      }),
      turnMessage("ci", "user", { eventType: "pull_request.checks.failed" }),
      tool("fix"),
      turnMessage("quiet-reply", "assistant", { quiet: true }),
      turnMessage("review", "user", { eventType: "pull_request.merged" }),
      turnMessage("merged-reply", "assistant"),
    ];
    expect([...quietTurnEntryKeys(entries)]).toEqual([
      "deploy",
      "quiet-reply",
      "ci",
    ]);
    expect(activityGroupSummary(entries.slice(2, 6))).toBe(
      "1 tool call · 2 events · 1 quiet reply",
    );
  });

  it("summarizes collapsed activity contents for the tooltip", () => {
    expect(activityGroupSummary([tool("1")])).toBe("1 tool call");
    expect(activityGroupSummary([tool("1"), reasoning("r1")])).toBe(
      "1 tool call · 1 reasoning entry",
    );
    expect(activityGroupSummary([tool("1"), tool("2"), compaction()])).toBe(
      "2 tool calls · context compacted",
    );
    expect(activityGroupSummary([compaction()])).toBe("context compacted");
  });

  it("shows the latest reasoning and only a running tool call after it", () => {
    const thought = (key: string, text: string): RenderedTranscriptEntry => ({
      key,
      kind: "reasoning",
      part: { text, type: "reasoning" },
      timestamp: 1,
    });
    const first = thought("r1", "Read the PR.");
    const second = thought("r2", "Compare the spans.");
    expect(liveActivityStep([first, tool("1"), second])).toEqual({
      reasoning: "Compare the spans.",
      tool: undefined,
    });
    // A finished tool call means Junior is thinking about the next step.
    expect(liveActivityStep([second, tool("2")]).tool).toBeUndefined();
    expect(
      liveActivityStep([first, tool("1"), second, tool("2", "running")]).tool
        ?.id,
    ).toBe("2");
    expect(liveActivityStep([tool("1", "running")]).reasoning).toBeUndefined();
  });
});
