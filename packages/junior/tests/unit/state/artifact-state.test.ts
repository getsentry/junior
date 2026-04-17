import { describe, expect, it } from "vitest";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";

describe("coerceThreadArtifactsState", () => {
  it("returns empty state for invalid input", () => {
    expect(coerceThreadArtifactsState(null)).toEqual({});
    expect(coerceThreadArtifactsState("bad")).toEqual({});
  });

  it("extracts artifact fields", () => {
    const state = coerceThreadArtifactsState({
      artifacts: {
        assistantContextChannelId: "C999",
        assistantTitleSourceMessageId: "msg-123",
        lastCanvasId: "F123",
        lastCanvasUrl: "https://example.com/canvas/F123",
        lastListId: "L123",
        lastListUrl: "https://example.com/list/L123",
        listColumnMap: {
          titleColumnId: "c1",
          completedColumnId: "c2",
        },
        updatedAt: "2026-02-25T00:00:00.000Z",
      },
    });

    expect(state.lastCanvasId).toBe("F123");
    expect(state.assistantContextChannelId).toBe("C999");
    expect(state.assistantTitleSourceMessageId).toBe("msg-123");
    expect(state.lastCanvasUrl).toBe("https://example.com/canvas/F123");
    expect(state.lastListId).toBe("L123");
    expect(state.lastListUrl).toBe("https://example.com/list/L123");
    expect(state.listColumnMap?.titleColumnId).toBe("c1");
    expect(state.listColumnMap?.completedColumnId).toBe("c2");
  });
});
