import { beforeEach, describe, expect, it, vi } from "vitest";

const completeObject = vi.fn(async () => ({
  costUsd: 0.0042,
  object: { ok: true },
}));
const completeDecision = vi.fn(async () => ({
  answers: {
    answer: {
      type: "choice",
      choice: "block",
      probabilities: { block: 0.9, allow: 0.1 },
    },
  },
}));
const embedTexts = vi.fn(async () => ({
  dimensions: 1,
  model: "test-embedding-model",
  provider: "test-provider",
  vectors: [[1]],
}));

vi.mock("@/chat/config", () => ({
  botConfig: {
    decisionModelId: "typesafe-ai/jev",
    defaultProfile: "standard",
    embeddingModelId: "test-embedding-model",
    fastModelId: "openai/gpt-5.4-mini",
    profiles: {
      standard: { modelId: "openai/gpt-5.5" },
    },
  },
}));

vi.mock("@/chat/pi/client", () => ({
  completeDecision,
  completeObject,
  embedTexts,
  GEN_AI_PROVIDER_NAME: "test-provider",
}));

describe("createPluginModel", () => {
  beforeEach(() => {
    completeObject.mockClear();
    embedTexts.mockClear();
  });

  it("uses the fast model for structured plugin calls by default", async () => {
    const { createPluginModel } = await import("@/chat/plugins/model");

    const result = await createPluginModel("test-plugin").completeObject({
      prompt: "classify",
      schema: {} as never,
    });

    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
      }),
    );
    expect(result).toEqual({ costUsd: 0.0042, object: { ok: true } });
  });

  it("uses the host default model when requested", async () => {
    const { createPluginModel } = await import("@/chat/plugins/model");

    await createPluginModel("test-plugin", {
      structuredModel: "default",
    }).completeObject({
      prompt: "extract",
      schema: {} as never,
    });

    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.5",
      }),
    );
  });

  it("passes host cancellation to plugin embedding calls", async () => {
    const { createPluginEmbedder } = await import("@/chat/plugins/model");
    const controller = new AbortController();

    await createPluginEmbedder("test-plugin", {
      signal: controller.signal,
    }).embedTexts({ texts: ["remember this"] });

    expect(embedTexts).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it("asks the decision model one choice question", async () => {
    const { createPluginDecider } = await import("@/chat/plugins/model");

    const result = await createPluginDecider("test-plugin").decide({
      criteria: { allow: "Safe change.", block: "Risky change." },
      instructions: "Judge the eval change.",
      state: "+ expect(reply).toBe('done')",
    });

    expect(completeDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "typesafe-ai/jev",
        questions: {
          answer: {
            type: "choice",
            instructions: "Judge the eval change.",
            criteria: { allow: "Safe change.", block: "Risky change." },
          },
        },
        state: "+ expect(reply).toBe('done')",
      }),
    );
    expect(result).toEqual({
      choice: "block",
      probabilities: { block: 0.9, allow: 0.1 },
    });
  });
});
