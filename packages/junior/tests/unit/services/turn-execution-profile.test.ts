import { describe, expect, it, vi } from "vitest";
import {
  selectTurnExecutionProfile,
  toAgentThinkingLevel,
} from "@/chat/services/turn-execution-profile";

describe("selectTurnExecutionProfile", () => {
  it("classifies even simple acknowledgment turns with the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_effort: "none",
        confidence: 0.99,
        reason: "acknowledgment only",
      },
    }));

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "thanks",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "none",
      reason: "acknowledgment only",
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
        reasoningEffort: "low",
      }),
    );
    expect(toAgentThinkingLevel(profile.reasoningEffort)).toBe("off");
  });

  it("classifies code-change asks with the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_effort: "high",
        confidence: 0.93,
        reason: "code change request",
      },
    }));

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText:
        "fix the failing test in packages/junior/src/chat/respond.ts",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "high",
      reason: "code change request",
    });
    expect(completeObject).toHaveBeenCalledOnce();
  });

  it("includes turn context in the classifier prompt", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_effort: "medium",
        confidence: 0.92,
        reason: "repo context plus ambiguity",
      },
    }));

    await selectTurnExecutionProfile({
      activeSkillNames: ["github", "github"],
      attachmentCount: 2,
      completeObject,
      conversationContext:
        "[user] dcramer: can you check this?\n[assistant] junior: maybe",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this approach?",
      modelId: "openai/gpt-5.4",
    });

    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
        prompt: expect.stringContaining(
          "Latest user request:\ncan you confirm this approach?",
        ),
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
        prompt: expect.stringContaining("Recent conversation context:"),
      }),
    );
  });

  it("falls back to the default low effort when classifier confidence is low", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_effort: "high",
        confidence: 0.4,
        reason: "not confident",
      },
    }));

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "low",
      reason: "low_confidence_default:not confident",
    });
  });

  it("falls back to the default low effort when the classifier fails", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("router failed");
    });

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "low",
      reason: "classifier_error_default",
    });
  });
});
