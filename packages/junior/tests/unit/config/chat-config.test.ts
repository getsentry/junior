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

  it("defaults lightModelId to the lightweight title model when fast model is unset", async () => {
    process.env.AI_MODEL = "anthropic/custom-model";
    delete process.env.AI_FAST_MODEL;
    delete process.env.AI_LIGHT_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.lightModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("prefers AI_LIGHT_MODEL over AI_FAST_MODEL for lightModelId", async () => {
    process.env.AI_MODEL = "anthropic/custom-model";
    process.env.AI_FAST_MODEL = "anthropic/custom-fast-model";
    process.env.AI_LIGHT_MODEL = "openai/gpt-5.4-mini";

    const { botConfig } = await loadConfig();
    expect(botConfig.lightModelId).toBe("openai/gpt-5.4-mini");
  });

  it("leaves visionModelId unset when AI_VISION_MODEL is absent", async () => {
    process.env.AI_MODEL = "anthropic/custom-model";
    delete process.env.AI_VISION_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.visionModelId).toBeUndefined();
  });

  it("uses AI_VISION_MODEL without falling back to AI_MODEL", async () => {
    process.env.AI_MODEL = "anthropic/custom-model";
    process.env.AI_VISION_MODEL = "openai/gpt-5.4";

    const { botConfig } = await loadConfig();
    expect(botConfig.modelId).toBe("anthropic/custom-model");
    expect(botConfig.visionModelId).toBe("openai/gpt-5.4");
  });

  it("uses default AGENT_TURN_TIMEOUT_MS when env var is unset", async () => {
    delete process.env.AGENT_TURN_TIMEOUT_MS;
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(720000);
  });

  it("uses AGENT_TURN_TIMEOUT_MS from env var when valid", async () => {
    process.env.AGENT_TURN_TIMEOUT_MS = "600000";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(600000);
  });

  it("falls back to default AGENT_TURN_TIMEOUT_MS when env var is invalid", async () => {
    process.env.AGENT_TURN_TIMEOUT_MS = "not-a-number";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(720000);
  });

  it("caps AGENT_TURN_TIMEOUT_MS to configured max", async () => {
    process.env.AGENT_TURN_TIMEOUT_MS = "999999";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(780000);
  });

  it("derives AGENT_TURN_TIMEOUT_MS cap from FUNCTION_MAX_DURATION_SECONDS", async () => {
    process.env.FUNCTION_MAX_DURATION_SECONDS = "500";
    process.env.AGENT_TURN_TIMEOUT_MS = "999999";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(480000);
  });

  it("falls back to QUEUE_CALLBACK_MAX_DURATION_SECONDS for backward compat", async () => {
    process.env.QUEUE_CALLBACK_MAX_DURATION_SECONDS = "500";
    process.env.AGENT_TURN_TIMEOUT_MS = "999999";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(480000);
  });
});
