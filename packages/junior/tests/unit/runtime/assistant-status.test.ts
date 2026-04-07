import { describe, expect, it } from "vitest";
import {
  buildAssistantStatusPresentation,
  makeAssistantStatus,
  normalizeAssistantStatusText,
} from "@/chat/runtime/assistant-status";

describe("assistant status presentation", () => {
  it("normalizes raw string statuses before rendering", () => {
    expect(normalizeAssistantStatusText("  Reading respond.ts...  ")).toBe(
      "Reading respond.ts",
    );
  });

  it("renders a typed reading status with a compact target", () => {
    expect(
      buildAssistantStatusPresentation({
        status: makeAssistantStatus("reading", "respond.ts"),
        random: () => 0,
      }),
    ).toEqual({
      key: "reading:respond.ts",
      hint: "Reading respond.ts",
      visible: "Reading respond.ts",
      suggestions: ["Reading respond.ts"],
    });
  });

  it("renders a standalone typed status when no context is available", () => {
    expect(
      buildAssistantStatusPresentation({
        status: makeAssistantStatus("thinking"),
        random: () => 0,
      }),
    ).toEqual({
      key: "thinking:task",
      hint: "Thinking task",
      visible: "Thinking task",
      suggestions: ["Thinking task"],
    });
  });

  it("renders variants from the declared status kind", () => {
    expect(
      buildAssistantStatusPresentation({
        status: makeAssistantStatus("searching", "sources"),
        random: () => 0.5,
      }),
    ).toEqual({
      key: "searching:sources",
      hint: "Searching sources",
      visible: "Probing sources",
      suggestions: ["Probing sources", "Searching sources"],
    });
  });

  it("normalizes typed status context before rendering", () => {
    expect(
      buildAssistantStatusPresentation({
        status: makeAssistantStatus("reading", "  respond.ts...  "),
        random: () => 0,
      }),
    ).toEqual({
      key: "reading:respond.ts",
      hint: "Reading respond.ts",
      visible: "Reading respond.ts",
      suggestions: ["Reading respond.ts"],
    });
  });
});
