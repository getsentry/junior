import { describe, expect, it } from "vitest";
import {
  buildAssistantStatusPresentation,
  normalizeAssistantStatusHint,
} from "@/chat/runtime/assistant-status";

describe("assistant status presentation", () => {
  it("normalizes semantic hints before rendering", () => {
    expect(normalizeAssistantStatusHint("  Reading file respond.ts...  ")).toBe(
      "Reading file respond.ts",
    );
  });

  it("renders a playful visible status while preserving the semantic hint", () => {
    expect(
      buildAssistantStatusPresentation({
        hint: "Reading file respond.ts...",
        currentVisible: "Poking around...",
        random: () => 0,
      }),
    ).toEqual({
      hint: "Reading file respond.ts",
      visible: "Digging in: Reading file respond.ts",
      suggestions: [
        "Digging in: Reading file respond.ts",
        "Reading file respond.ts",
      ],
    });
  });

  it("renders a standalone playful status when no semantic hint is available", () => {
    expect(
      buildAssistantStatusPresentation({
        hint: "",
        currentVisible: "",
        random: () => 0,
      }),
    ).toEqual({
      hint: "",
      visible: "Poking around...",
      suggestions: ["Poking around..."],
    });
  });
});
