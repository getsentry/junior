import { beforeEach, describe, expect, it, vi } from "vitest";

const completeObject = vi.fn(async () => ({
  costUsd: 0.0042,
  object: { ok: true },
}));
const embedTexts = vi.fn(async () => ({
  dimensions: 1,
  model: "test-embedding-model",
  provider: "test-provider",
  vectors: [[1]],
}));

vi.mock("@/chat/config", () => ({
  botConfig: {
    defaultProfile: "standard",
    embeddingModelId: "test-embedding-model",
    fastModelId: "openai/gpt-5.4-mini",
    profiles: {
      standard: { modelId: "openai/gpt-5.5" },
    },
  },
}));

vi.mock("@/chat/pi/client", () => ({
  completeObject,
  embedTexts,
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
});
