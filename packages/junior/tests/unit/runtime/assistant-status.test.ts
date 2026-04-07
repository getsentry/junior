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
        currentVisible: "Skimming respond.ts",
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
        currentVisible: "",
        random: () => 0,
      }),
    ).toEqual({
      key: "thinking:task",
      hint: "Thinking task",
      visible: "Thinking task",
      suggestions: ["Thinking task"],
    });
  });

  it("rotates within a status kind when the current visible verb is already used", () => {
    expect(
      buildAssistantStatusPresentation({
        status: makeAssistantStatus("searching", "sources"),
        currentVisible: "Searching sources",
        random: () => 0,
      }),
    ).toEqual({
      key: "searching:sources",
      hint: "Searching sources",
      visible: "Scanning sources",
      suggestions: ["Scanning sources", "Searching sources"],
    });
  });

  it("passes raw string statuses through as already-rendered text", () => {
    expect(
      buildAssistantStatusPresentation({
        status: "Reading respond.ts",
        currentVisible: "",
        random: () => 0,
      }),
    ).toEqual({
      key: "text:Reading respond.ts",
      hint: "Reading respond.ts",
      visible: "Reading respond.ts",
      suggestions: ["Reading respond.ts"],
    });
  });
});
