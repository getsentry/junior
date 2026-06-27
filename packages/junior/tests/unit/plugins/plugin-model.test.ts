import { beforeEach, describe, expect, it, vi } from "vitest";

const completeObject = vi.fn(async () => ({ object: { ok: true } }));

vi.mock("@/chat/config", () => ({
  botConfig: {
    embeddingModelId: "test-embedding-model",
    fastModelId: "openai/gpt-5.4-mini",
    modelId: "openai/gpt-5.5",
  },
}));

vi.mock("@/chat/pi/client", () => ({
  completeObject,
  embedTexts: vi.fn(),
}));

describe("createPluginModel", () => {
  beforeEach(() => {
    completeObject.mockClear();
  });

  it("uses the fast model for structured plugin calls by default", async () => {
    const { createPluginModel } = await import("@/chat/plugins/model");

    await createPluginModel("test-plugin").completeObject({
      prompt: "classify",
      schema: {} as never,
    });

    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.4-mini",
      }),
    );
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
});
