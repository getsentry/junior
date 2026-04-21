import { describe, expect, it, vi } from "vitest";
import {
  selectTurnExecutionProfile,
  toAgentThinkingLevel,
} from "@/chat/services/turn-execution-profile";

describe("selectTurnExecutionProfile", () => {
  it("keeps acknowledgments at none without calling the classifier", async () => {
    const completeObject = vi.fn();

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "thanks",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "none",
      reason: "acknowledgment_only",
      source: "heuristic",
    });
    expect(completeObject).not.toHaveBeenCalled();
    expect(toAgentThinkingLevel(profile.reasoningEffort)).toBe("off");
  });

  it("routes code-change asks to high without a classifier call", async () => {
    const completeObject = vi.fn();

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText:
        "fix the failing test in packages/junior/src/chat/respond.ts",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "high",
      reason: "code_change_request",
      source: "heuristic",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("routes repo investigations to medium without a classifier call", async () => {
    const completeObject = vi.fn();

    const profile = await selectTurnExecutionProfile({
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText:
        "let's dig into https://github.com/getsentry/junior/issues/233",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "medium",
      reason: "repo_investigation_request",
      source: "heuristic",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("uses the fast-model classifier for ambiguous higher-risk asks", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        reasoning_effort: "medium",
        confidence: 0.92,
        reason: "repo context plus ambiguity",
      },
    }));

    const profile = await selectTurnExecutionProfile({
      activeSkillNames: ["github"],
      completeObject,
      conversationContext:
        "[user] dcramer: can you check this?\n[assistant] junior: maybe",
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this approach?",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "medium",
      source: "classifier",
      reason: "repo context plus ambiguity",
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
        reasoningEffort: "low",
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
      activeSkillNames: ["github"],
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "low",
      reason: "low_confidence_default:not confident",
      source: "classifier",
    });
  });

  it("falls back to the default low effort when the classifier fails", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("router failed");
    });

    const profile = await selectTurnExecutionProfile({
      activeSkillNames: ["github"],
      completeObject,
      fastModelId: "openai/gpt-5.4-mini",
      messageText: "can you confirm this repo plan?",
      modelId: "openai/gpt-5.4",
    });

    expect(profile).toMatchObject({
      reasoningEffort: "low",
      reason: "classifier_error_default",
      source: "classifier",
    });
  });
});
