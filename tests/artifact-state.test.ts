import { describe, expect, it } from "vitest";
import { coerceThreadArtifactsState } from "@/chat/slack-actions/types";

describe("coerceThreadArtifactsState", () => {
  it("returns empty state for invalid input", () => {
    expect(coerceThreadArtifactsState(null)).toEqual({});
    expect(coerceThreadArtifactsState("bad")).toEqual({});
  });

  it("extracts artifact fields", () => {
    const state = coerceThreadArtifactsState({
      artifacts: {
        lastCanvasId: "F123",
        lastListId: "L123",
        listColumnMap: {
          titleColumnId: "c1",
          completedColumnId: "c2"
        },
        updatedAt: "2026-02-25T00:00:00.000Z"
      }
    });

    expect(state.lastCanvasId).toBe("F123");
    expect(state.lastListId).toBe("L123");
    expect(state.listColumnMap?.titleColumnId).toBe("c1");
    expect(state.listColumnMap?.completedColumnId).toBe("c2");
  });
});
