import { describe, expect, it, vi } from "vitest";
import {
  selectTurnThinkingLevel,
  toAgentThinkingLevel,
} from "@/chat/services/turn-thinking-level";

describe("selectTurnThinkingLevel", () => {
  it("classifies even simple acknowledgment turns with the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "none",
        confidence: 0.99,
        reason: "acknowledgment only",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "thanks",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "none",
      reason: "acknowledgment only",
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
        thinkingLevel: "low",
      }),
    );
    expect(toAgentThinkingLevel(profile.thinkingLevel)).toBe("off");
  });

  it("classifies code-change asks with the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "high",
        confidence: 0.93,
        reason: "code change request",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText:
        "fix the failing test in packages/junior/src/chat/respond.ts",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "high",
      reason: "code change request",
    });
    expect(completeObject).toHaveBeenCalledOnce();
  });

  it("falls back to medium effort when classifier confidence is low", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "high",
        confidence: 0.4,
        reason: "not confident",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "medium",
      reason: "low_confidence_medium_default:not confident",
    });
    expect(toAgentThinkingLevel(profile.thinkingLevel)).toBe("medium");
  });

  it("falls back to medium effort when the classifier fails", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("router failed");
    });

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "medium",
      reason: "classifier_error_default",
    });
  });

  it("preserves high-confidence low classifications for deterministic simple work", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "low",
        confidence: 0.97,
        reason: "deterministic one-step transform",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "alphabetize these words: beta, alpha",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "low",
      reason: "deterministic one-step transform",
    });
    expect(toAgentThinkingLevel(profile.thinkingLevel)).toBe("low");
  });

  it("floors source-backed context turns at medium unless they are acknowledgments", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "low",
        confidence: 0.92,
        reason: "simple follow-up",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      conversationContext: "Earlier task: double-check the repo evidence.",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "medium",
      reason: "thinking_floor:medium:simple follow-up",
    });
  });

  it("does not floor acknowledgment turns with thread context", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "none",
        confidence: 0.96,
        reason: "thanks only",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      conversationContext: "Earlier answer already resolved the task.",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "thanks",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "none",
      reason: "thanks only",
    });
  });

  it("truncates very long thread context with head + tail slices", async () => {
    let capturedPrompt = "";
    const completeObject = async ({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return {
        object: {
          thinking_level: "medium",
          confidence: 0.9,
          reason: "ok",
        },
      };
    };

    const headMarker = "ORIGINAL_TASK_FRAMING_HEAD";
    const tailMarker = "MOST_RECENT_TURN_TAIL";
    const filler = "filler text. ".repeat(2_000);
    const longContext = `${headMarker} ${filler} ${tailMarker}`;

    await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go",
      conversationContext: longContext,
    });

    expect(capturedPrompt).toContain(headMarker);
    expect(capturedPrompt).toContain(tailMarker);
    expect(capturedPrompt).toContain("…[truncated]…");
  });
});
