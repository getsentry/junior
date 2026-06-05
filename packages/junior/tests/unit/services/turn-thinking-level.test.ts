import { describe, expect, it, vi } from "vitest";
import {
  selectTurnThinkingLevel,
  toAgentThinkingLevel,
} from "@/chat/services/turn-thinking-level";

describe("selectTurnThinkingLevel", () => {
  it("returns high-confidence router selections and uses fast model defaults", async () => {
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

  it("keeps high-confidence low selections when no floor applies", async () => {
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

  it("accepts common string confidence labels from the classifier", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "low",
        confidence: "high",
        reason: "deterministic single-step command",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "anthropic/claude-haiku-4.5",
      messageText: "can you clone getsentry/test-internal-repo",
    });

    expect(profile).toMatchObject({
      confidence: 0.9,
      thinkingLevel: "low",
      reason: "deterministic single-step command",
    });
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

  it("passes current-turn attachment blocks to the router input", async () => {
    let routerInput = "";
    const completeObject = async ({ prompt }: { prompt: string }) => {
      routerInput = prompt;
      return {
        object: {
          thinking_level: "high",
          confidence: 0.95,
          reason: "attachment stack trace",
        },
      };
    };

    const profile = await selectTurnThinkingLevel({
      completeObject,
      currentTurnBlocks: [
        [
          "<attachment>",
          "filename: error.json",
          "media_type: application/vnd.api+json; charset=utf-8",
          "<text-preview>",
          '{"error":"TypeError: x is undefined"}',
          "</text-preview>",
          "</attachment>",
        ].join("\n"),
      ],
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you fix this?",
    });

    expect(routerInput).toContain("<current-instruction>");
    expect(routerInput).toContain("filename: error.json");
    expect(routerInput).toContain("TypeError: x is undefined");
    expect(profile).toMatchObject({
      thinkingLevel: "high",
      reason: "attachment stack trace",
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

  it("passes truncated thread context with head and tail slices", async () => {
    let routerInput = "";
    const completeObject = async ({ prompt }: { prompt: string }) => {
      routerInput = prompt;
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

    expect(routerInput).toContain(headMarker);
    expect(routerInput).toContain(tailMarker);
    expect(routerInput).toContain("…[truncated]…");
  });

  it("does not floor xhigh classifications", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "xhigh",
        confidence: 0.95,
        reason: "multi-file refactor with architecture implications",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      conversationContext: "Prior task context about a large refactor.",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go ahead and implement the refactor",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "xhigh",
      reason: "multi-file refactor with architecture implications",
    });
    expect(toAgentThinkingLevel(profile.thinkingLevel)).toBe("xhigh");
  });
});
