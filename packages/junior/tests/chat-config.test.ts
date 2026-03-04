import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadConfig() {
  vi.resetModules();
  return import("@/chat/config");
}

describe("chat config", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("uses AI_MODEL for fastModelId when AI_FAST_MODEL is unset", async () => {
    process.env.AI_MODEL = "anthropic/custom-model";
    delete process.env.AI_FAST_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.modelId).toBe("anthropic/custom-model");
    expect(botConfig.fastModelId).toBe("anthropic/custom-model");
  });

  it("prefers AI_FAST_MODEL over AI_MODEL for fastModelId", async () => {
    process.env.AI_MODEL = "anthropic/custom-model";
    process.env.AI_FAST_MODEL = "anthropic/custom-fast-model";

    const { botConfig } = await loadConfig();
    expect(botConfig.fastModelId).toBe("anthropic/custom-fast-model");
  });
});
