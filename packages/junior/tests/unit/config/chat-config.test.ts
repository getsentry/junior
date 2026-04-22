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
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    delete process.env.AI_FAST_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.modelId).toBe("anthropic/claude-opus-4.6");
    expect(botConfig.fastModelId).toBe("anthropic/claude-opus-4.6");
  });

  it("prefers AI_FAST_MODEL over AI_MODEL for fastModelId", async () => {
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    process.env.AI_FAST_MODEL = "anthropic/claude-haiku-4.5";

    const { botConfig } = await loadConfig();
    expect(botConfig.fastModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("uses the default fast model when AI_MODEL and AI_FAST_MODEL are unset", async () => {
    delete process.env.AI_MODEL;
    delete process.env.AI_FAST_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.fastModelId).toBe("openai/gpt-5.4-mini");
  });

  it("uses the default main model when AI_MODEL is unset", async () => {
    delete process.env.AI_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.modelId).toBe("openai/gpt-5.4");
  });

  it("ignores AI_LIGHT_MODEL and keeps using AI_FAST_MODEL", async () => {
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    process.env.AI_FAST_MODEL = "anthropic/claude-haiku-4.5";
    process.env.AI_LIGHT_MODEL = "openai/gpt-5.4-mini";

    const { botConfig } = await loadConfig();
    expect(botConfig.fastModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("leaves visionModelId unset when AI_VISION_MODEL is absent", async () => {
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    delete process.env.AI_VISION_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.visionModelId).toBeUndefined();
  });

  it("uses AI_VISION_MODEL without falling back to AI_MODEL", async () => {
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    process.env.AI_VISION_MODEL = "openai/gpt-5.4";

    const { botConfig } = await loadConfig();
    expect(botConfig.modelId).toBe("anthropic/claude-opus-4.6");
    expect(botConfig.visionModelId).toBe("openai/gpt-5.4");
  });

  it("throws at config load when AI_MODEL is not a registered gateway model id", async () => {
    process.env.AI_MODEL = "openai/gpt-definitely-not-real";

    await expect(loadConfig()).rejects.toThrow(/Unknown AI Gateway model id/);
  });

  it("uses the default assistant loading messages when unset", async () => {
    delete process.env.JUNIOR_LOADING_MESSAGES;
    const { botConfig } = await loadConfig();
    expect(botConfig.loadingMessages.length).toBeGreaterThan(0);
  });

  it("uses JUNIOR_LOADING_MESSAGES when configured", async () => {
    process.env.JUNIOR_LOADING_MESSAGES = JSON.stringify([
      "Consulting the orb",
      "Bribing the gremlins",
    ]);

    const { botConfig } = await loadConfig();
    expect(botConfig.loadingMessages).toEqual([
      "Consulting the orb",
      "Bribing the gremlins",
    ]);
  });

  it("throws when JUNIOR_LOADING_MESSAGES is not a JSON string array", async () => {
    process.env.JUNIOR_LOADING_MESSAGES = '{"nope":true}';

    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_LOADING_MESSAGES must be a JSON array of strings",
    );
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
