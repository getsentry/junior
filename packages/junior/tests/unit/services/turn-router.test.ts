import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderError } from "@/chat/services/provider-error";
import {
  configuredTurnRoute,
  selectTurnRoute,
  toPiReasoningLevel,
} from "@/chat/services/turn-router";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logWarn: mocks.logWarn,
}));

const profiles = {
  standard: {
    modelId: "xai/grok-4.5",
    description: "Default general assistant work.",
  },
  handoff: {
    modelId: "openai/gpt-5.6-sol",
    description: "Use for coding and difficult multi-step work.",
  },
};
type CompleteDecision = Parameters<
  typeof selectTurnRoute
>[0]["completeDecision"];

// Decision answer with the given probability for each chosen option.
function decision(
  profile: string,
  reasoningLevel: string,
  probability = 0.95,
  costUsd?: number,
): Awaited<ReturnType<CompleteDecision>> {
  return {
    answers: {
      profile: { choice: profile, probabilities: { [profile]: probability } },
      reasoning_level: {
        choice: reasoningLevel,
        probabilities: { [reasoningLevel]: probability },
      },
    },
    ...(costUsd !== undefined ? { costUsd } : undefined),
  };
}

const routeTurn = (
  args: Omit<
    Parameters<typeof selectTurnRoute>[0],
    "currentProfile" | "profiles"
  >,
) => selectTurnRoute({ ...args, currentProfile: "standard", profiles });

describe("selectTurnRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps configured reasoning independent from model routing", () => {
    expect(configuredTurnRoute("standard", "xhigh", "agent_config")).toEqual({
      profile: "standard",
      reasoningLevel: "xhigh",
      reason: "configured:agent_config",
      source: "configured",
    });
  });

  it("asks the decision model one profile and one reasoning-level question", async () => {
    const completeDecision = vi.fn<CompleteDecision>(async () =>
      decision("standard", "none", 0.99, 0.00012),
    );

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "thanks",
    });

    expect(profile).toMatchObject({
      confidence: 0.99,
      costUsd: 0.00012,
      reasoningLevel: "none",
      profile: "standard",
      reason: "standard p=0.99, none p=0.99",
      source: "router",
    });
    const call = completeDecision.mock.calls[0]![0];
    expect(call).toMatchObject({
      modelId: "typesafe-ai/jev",
      promptName: "junior.thinking_route",
      metadata: { modelId: "typesafe-ai/jev" },
    });
    expect(call.questions.profile).toMatchObject({
      type: "choice",
      instructions: expect.stringContaining('Current profile: "standard"'),
      criteria: {
        standard: "Default general assistant work.",
        handoff: "Use for coding and difficult multi-step work.",
      },
    });
    expect(call.questions.reasoning_level.type).toBe("choice");
    expect(Object.keys(call.questions.reasoning_level.criteria)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("off");
  });

  it("classifies code-change asks as xhigh", async () => {
    const completeDecision = vi.fn(async () =>
      decision("handoff", "xhigh", 0.93),
    );

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText:
        "fix the failing test in packages/junior/src/chat/agent-run.ts",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "xhigh",
      profile: "handoff",
    });
    expect(completeDecision).toHaveBeenCalledOnce();
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("xhigh");
  });

  it("wraps and escapes the current instruction in the classifier prompt", async () => {
    let capturedPrompt = "";
    const completeDecision = async ({ state }: { state: string }) => {
      capturedPrompt = state;
      return decision("standard", "medium", 0.9);
    };

    await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
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
    const completeDecision = vi.fn(async () =>
      decision("handoff", "high", 0.91),
    );

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "research how the Slack delivery pipeline works end to end",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "high",
      profile: "handoff",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("high");
  });

  it("applies a profile's forced reasoning level", async () => {
    const completeDecision = vi.fn(async () =>
      decision("handoff", "high", 0.91),
    );

    const profile = await selectTurnRoute({
      completeDecision,
      currentProfile: "standard",
      modelId: "typesafe-ai/jev",
      messageText: "research this architecture",
      profiles: {
        ...profiles,
        handoff: {
          ...profiles.handoff,
          reasoningLevel: "xhigh",
        },
      },
    });

    expect(profile).toMatchObject({
      profile: "handoff",
      reasoningLevel: "xhigh",
      reason: "profile_reasoning_override:handoff:handoff p=0.91, high p=0.91",
    });
  });

  it("falls back to medium effort when classifier confidence is low", async () => {
    const completeDecision = vi.fn(async () =>
      decision("standard", "high", 0.4),
    );

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "can you confirm this repo plan?",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "medium",
      profile: "standard",
      reason: "low_confidence_medium_default:standard p=0.40, high p=0.40",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("medium");
  });

  it("keeps the current profile when confidence is low", async () => {
    const completeDecision = vi.fn(async () => decision("coding", "high", 0.4));

    const profile = await selectTurnRoute({
      completeDecision,
      currentProfile: "expert",
      modelId: "typesafe-ai/jev",
      messageText: "can you confirm this repo plan?",
      profiles: {
        expert: { modelId: "anthropic/claude-opus-5" },
        coding: { modelId: "openai/gpt-5.6-sol" },
      },
    });

    expect(profile).toMatchObject({
      reasoningLevel: "medium",
      profile: "expert",
      reason: "low_confidence_medium_default:coding p=0.40, high p=0.40",
    });
  });

  it("falls back to medium effort when the classifier fails", async () => {
    const completeDecision = vi.fn(async () => {
      throw new Error("router failed");
    });

    const profile = await selectTurnRoute({
      completeDecision,
      currentProfile: "expert",
      modelId: "typesafe-ai/jev",
      messageText: "can you confirm this repo plan?",
      profiles: {
        expert: { modelId: "anthropic/claude-opus-5" },
        coding: { modelId: "openai/gpt-5.6-sol" },
      },
    });

    expect(profile).toMatchObject({
      profile: "expert",
      reasoningLevel: "medium",
      reason: "classifier_error_default",
    });
    expect(completeDecision).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "turn.router.classifier.failed",
      {
        "exception.message": "router failed",
      },
    );
  });

  it("retries once and succeeds after a transient invalid_response failure", async () => {
    const completeDecision = vi
      .fn()
      .mockRejectedValueOnce(
        createProviderError(new Error("malformed object"), {
          kind: "invalid_response",
        }),
      )
      .mockResolvedValueOnce(decision("coding", "high", 0.95));

    const profile = await selectTurnRoute({
      completeDecision,
      currentProfile: "expert",
      modelId: "typesafe-ai/jev",
      messageText: "refactor this module and add tests",
      profiles: {
        expert: { modelId: "anthropic/claude-opus-5" },
        coding: { modelId: "openai/gpt-5.6-sol" },
      },
    });

    expect(completeDecision).toHaveBeenCalledTimes(2);
    expect(profile).toMatchObject({
      profile: "coding",
      reasoningLevel: "high",
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("gives up after a second consecutive invalid_response failure", async () => {
    const completeDecision = vi.fn(async () => {
      throw createProviderError(new Error("still malformed"), {
        kind: "invalid_response",
      });
    });

    const profile = await selectTurnRoute({
      completeDecision,
      currentProfile: "expert",
      modelId: "typesafe-ai/jev",
      messageText: "refactor this module and add tests",
      profiles: {
        expert: { modelId: "anthropic/claude-opus-5" },
        coding: { modelId: "openai/gpt-5.6-sol" },
      },
    });

    expect(completeDecision).toHaveBeenCalledTimes(2);
    expect(profile).toMatchObject({
      profile: "expert",
      reasoningLevel: "medium",
      reason: "classifier_error_default",
    });
  });

  it("does not retry non-retryable classifier errors", async () => {
    const completeDecision = vi.fn(async () => {
      throw createProviderError(new Error("no credits"), {
        kind: "quota",
      });
    });

    const profile = await selectTurnRoute({
      completeDecision,
      currentProfile: "expert",
      modelId: "typesafe-ai/jev",
      messageText: "refactor this module and add tests",
      profiles: {
        expert: { modelId: "anthropic/claude-opus-5" },
        coding: { modelId: "openai/gpt-5.6-sol" },
      },
    });

    expect(completeDecision).toHaveBeenCalledTimes(1);
    expect(profile).toMatchObject({
      profile: "expert",
      reasoningLevel: "medium",
      reason: "classifier_error_default",
    });
  });

  it("preserves high-confidence low classifications for deterministic simple work", async () => {
    const completeDecision = vi.fn(async () =>
      decision("standard", "low", 0.97),
    );

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "alphabetize these words: beta, alpha",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "low",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("low");
  });

  it("uses the lower probability of the two answers as confidence", async () => {
    const completeDecision = vi.fn<CompleteDecision>(async () => ({
      answers: {
        profile: {
          choice: "handoff",
          probabilities: { handoff: 0.95, standard: 0.05 },
        },
        reasoning_level: {
          choice: "high",
          probabilities: { high: 0.6, xhigh: 0.4 },
        },
      },
    }));

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "review this architecture plan",
    });

    expect(profile).toMatchObject({
      confidence: 0.6,
      profile: "standard",
      reasoningLevel: "medium",
      reason: "low_confidence_medium_default:handoff p=0.95, high p=0.60",
    });
  });

  it("treats answers without probabilities as certain", async () => {
    const completeDecision = vi.fn<CompleteDecision>(async () => ({
      answers: {
        profile: { choice: "handoff" },
        reasoning_level: { choice: "xhigh" },
      },
    }));

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "fix the flaky test",
    });

    expect(profile).toMatchObject({
      confidence: 1,
      profile: "handoff",
      reasoningLevel: "xhigh",
    });
  });

  it("falls back when the decision model picks an unknown profile", async () => {
    const completeDecision = vi.fn<CompleteDecision>(async () =>
      decision("expert", "high"),
    );

    const profile = await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "research this",
    });

    expect(completeDecision).toHaveBeenCalledOnce();
    expect(profile).toMatchObject({
      profile: "standard",
      reasoningLevel: "medium",
      reason: "classifier_error_default",
    });
  });

  it("floors source-backed context turns at medium unless they are acknowledgments", async () => {
    const completeDecision = vi.fn(async () =>
      decision("standard", "low", 0.92),
    );

    const profile = await routeTurn({
      completeDecision,
      conversationContext: "Earlier task: double-check the repo evidence.",
      modelId: "typesafe-ai/jev",
      messageText: "go",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "medium",
      reason: "reasoning_floor:medium:standard p=0.92, low p=0.92",
    });
  });

  it("does not floor acknowledgment turns with thread context", async () => {
    const completeDecision = vi.fn(async () =>
      decision("standard", "none", 0.96),
    );

    const profile = await routeTurn({
      completeDecision,
      conversationContext: "Earlier answer already resolved the task.",
      modelId: "typesafe-ai/jev",
      messageText: "thanks",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "none",
    });
  });

  it("truncates very long thread context with head + tail slices", async () => {
    let capturedPrompt = "";
    const completeDecision = async ({ state }: { state: string }) => {
      capturedPrompt = state;
      return decision("standard", "medium", 0.9);
    };

    const headMarker = "ORIGINAL_TASK_FRAMING_HEAD";
    const tailMarker = "MOST_RECENT_TURN_TAIL";
    const filler = "filler text. ".repeat(2_000);
    const longContext = `${headMarker} ${filler} ${tailMarker}`;

    await routeTurn({
      completeDecision,
      modelId: "typesafe-ai/jev",
      messageText: "go",
      conversationContext: longContext,
    });

    expect(capturedPrompt).toContain(headMarker);
    expect(capturedPrompt).toContain(tailMarker);
    expect(capturedPrompt).toContain("…[truncated]…");
    expect(capturedPrompt).toContain(
      '<thread-context authority="evidence-only">',
    );
    expect(capturedPrompt).toContain("</thread-context>");
  });

  it("does not floor xhigh classifications", async () => {
    const completeDecision = vi.fn(async () =>
      decision("handoff", "xhigh", 0.95),
    );

    const profile = await routeTurn({
      completeDecision,
      conversationContext: "Prior task context about a large refactor.",
      modelId: "typesafe-ai/jev",
      messageText: "go ahead and implement the refactor",
    });

    expect(profile).toMatchObject({
      reasoningLevel: "xhigh",
      profile: "handoff",
    });
    expect(toPiReasoningLevel(profile.reasoningLevel)).toBe("xhigh");
  });
});
