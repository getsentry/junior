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

  it("falls back to the default low effort when classifier confidence is low", async () => {
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
      thinkingLevel: "low",
      reason: "low_confidence_default:not confident",
    });
  });

  it("falls back to the default low effort when the classifier fails", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("router failed");
    });

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "low",
      reason: "classifier_error_default",
    });
  });

  it("promotes 'none' to 'low' for a short follow-up in a thread with prior context", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "none",
        confidence: 0.95,
        reason: "short message",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "go",
      conversationContext:
        "user: investigate the signup 500s and draft a github issue\nbot: want me to start now?",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "low",
      reason: "short_followup_no_none:short message",
    });
  });

  it("leaves 'none' in place for a short message with no thread context", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "none",
        confidence: 0.95,
        reason: "greeting",
      },
    }));

    const profile = await selectTurnThinkingLevel({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "hello",
    });

    expect(profile).toMatchObject({
      thinkingLevel: "none",
      reason: "greeting",
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
