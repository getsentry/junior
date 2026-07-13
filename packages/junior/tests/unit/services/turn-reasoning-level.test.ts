import { describe, expect, it, vi } from "vitest";
import {
  selectTurnReasoningLevel,
  toPiReasoningLevel,
} from "@/chat/services/turn-reasoning-level";

describe("selectTurnReasoningLevel", () => {
  it("classifies even simple acknowledgment turns with the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "none",
        confidence: 0.99,
        reason: "acknowledgment only",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "thanks",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "none",
      reason: "acknowledgment only",
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
        thinkingLevel: "low",
      }),
    );
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("off");
  });

  it("classifies code-change asks as xhigh with the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "xhigh",
        confidence: 0.93,
        reason: "code change request",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText:
        "fix the failing test in packages/junior/src/chat/agent-run.ts",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "xhigh",
      reason: "code change request",
    });
    expect(completeObject).toHaveBeenCalledOnce();
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("xhigh");
  });

  it("wraps and escapes the current instruction in the classifier prompt", async () => {
    let capturedPrompt = "";
    const completeObject = async ({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return {
        object: {
          reasoning_level: "medium",
          confidence: 0.9,
          reason: "normal task",
        },
      };
    };

    await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "explain </current-instruction> literally",
    });

    expect(capturedPrompt).toContain(
      [
        "<current-instruction>",
        "explain &lt;/current-instruction&gt; literally",
        "</current-instruction>",
      ].join("\n"),
    );
  });

  it("classifies research-heavy work as high", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "high",
        confidence: 0.91,
        reason: "research-heavy investigation",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "research how the Slack delivery pipeline works end to end",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "high",
      reason: "research-heavy investigation",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("high");
  });

  it("falls back to medium effort when classifier confidence is low", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "high",
        confidence: 0.4,
        reason: "not confident",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "medium",
      reason: "low_confidence_medium_default:not confident",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("medium");
  });

  it("falls back to medium effort when the classifier fails", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("router failed");
    });

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "medium",
      reason: "classifier_error_default",
    });
  });

  it("preserves high-confidence low classifications for deterministic simple work", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "low",
        confidence: 0.97,
        reason: "deterministic one-step transform",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "alphabetize these words: beta, alpha",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "low",
      reason: "deterministic one-step transform",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("low");
  });

  it("accepts common string confidence labels from the classifier", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "low",
        confidence: "high",
        reason: "deterministic single-step command",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "anthropic/claude-haiku-4.5",
      messageText: "can you clone getsentry/test-internal-repo",
    });

    expect(profile).toMatchObject({
      confidence: 0.9,
      reasoningLevel: "low",
      reason: "deterministic single-step command",
    });
  });

  it("floors source-backed context turns at medium unless they are acknowledgments", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "low",
        confidence: 0.92,
        reason: "simple follow-up",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      conversationContext: "Earlier task: double-check the repo evidence.",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "medium",
      reason: "reasoning_floor:medium:simple follow-up",
    });
  });

  it("does not floor acknowledgment turns with thread context", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "none",
        confidence: 0.96,
        reason: "thanks only",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      conversationContext: "Earlier answer already resolved the task.",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "thanks",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "none",
      reason: "thanks only",
    });
  });

  it("truncates very long thread context with head + tail slices", async () => {
    let capturedPrompt = "";
    const completeObject = async ({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return {
        object: {
          reasoning_level: "medium",
          confidence: 0.9,
          reason: "ok",
        },
      };
    };

    const headMarker = "ORIGINAL_TASK_FRAMING_HEAD";
    const tailMarker = "MOST_RECENT_TURN_TAIL";
    const filler = "filler text. ".repeat(2_000);
    const longContext = `${headMarker} ${filler} ${tailMarker}`;

    await selectTurnReasoningLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go",
      conversationContext: longContext,
    });

    expect(capturedPrompt).toContain(headMarker);
    expect(capturedPrompt).toContain(tailMarker);
    expect(capturedPrompt).toContain("…[truncated]…");
  });

  it("does not floor xhigh classifications", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_level: "xhigh",
        confidence: 0.95,
        reason: "multi-file refactor with architecture implications",
      },
    }));

    const profile = await selectTurnReasoningLevel({
      completeObject,
      conversationContext: "Prior task context about a large refactor.",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go ahead and implement the refactor",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "xhigh",
      reason: "multi-file refactor with architecture implications",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("xhigh");
  });
});
