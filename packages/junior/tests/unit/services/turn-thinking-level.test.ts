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

  it("includes turn context in the classifier prompt", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        thinking_level: "medium",
        confidence: 0.92,
        reason: "repo context plus ambiguity",
      },
    }));

    await selectTurnThinkingLevel({
      activeSkillNames: ["github", "github"],
      attachmentCount: 2,
      completeObject,
      conversationContext:
        "[user] dcramer: can you check this?\n[assistant] junior: maybe",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this approach?",
    });

    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
        prompt: expect.stringContaining(
          '<current-instruction priority="highest">\ncan you confirm this approach?\n</current-instruction>',
        ),
      }),
    );
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("<turn-context>"),
      }),
    );
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("- active_skills: github"),
      }),
    );
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("- attachment_count: 2"),
      }),
    );
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("<thread-background>"),
      }),
    );
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
});
