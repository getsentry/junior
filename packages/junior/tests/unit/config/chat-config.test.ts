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

  it("uses the default slash command when JUNIOR_SLASH_COMMAND is unset", async () => {
    delete process.env.JUNIOR_SLASH_COMMAND;

    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().slack.slashCommand).toBe("/jr");
  });

  it("uses JUNIOR_SLASH_COMMAND when configured", async () => {
    process.env.JUNIOR_SLASH_COMMAND = " /junior ";

    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().slack.slashCommand).toBe("/junior");
  });

  it("throws when JUNIOR_SLASH_COMMAND is invalid", async () => {
    process.env.JUNIOR_SLASH_COMMAND = "junior command";

    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_SLASH_COMMAND must start with / and contain no whitespace",
    );
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

  it("reads optional model context window overrides", async () => {
    process.env.AI_MODEL_CONTEXT_WINDOW_TOKENS = "200000";

    const { botConfig } = await loadConfig();
    expect(botConfig.modelContextWindowTokens).toBe(200000);
  });

  it("throws when model context window overrides are invalid", async () => {
    process.env.AI_MODEL_CONTEXT_WINDOW_TOKENS = "0";

    await expect(loadConfig()).rejects.toThrow(
      "AI_MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer",
    );
  });

  it("uses the default advisor config when AI_ADVISOR_MODEL is absent", async () => {
    delete process.env.AI_ADVISOR_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.advisor).toMatchObject({
      modelId: "openai/gpt-5.5",
      thinkingLevel: "xhigh",
    });
  });

  it("parses advisor config when AI_ADVISOR_MODEL is set", async () => {
    process.env.AI_ADVISOR_MODEL = "openai/gpt-5.4";
    process.env.AI_ADVISOR_THINKING_LEVEL = "xhigh";

    const { botConfig } = await loadConfig();
    expect(botConfig.advisor).toEqual({
      modelId: "openai/gpt-5.4",
      thinkingLevel: "xhigh",
    });
  });

  it("throws at config load when AI_ADVISOR_MODEL is not registered", async () => {
    process.env.AI_ADVISOR_MODEL = "openai/gpt-definitely-not-real";

    await expect(loadConfig()).rejects.toThrow(/Unknown AI Gateway model id/);
  });

  it("throws at config load when AI_ADVISOR_THINKING_LEVEL is invalid", async () => {
    process.env.AI_ADVISOR_MODEL = "openai/gpt-5.4";
    process.env.AI_ADVISOR_THINKING_LEVEL = "deeply";

    await expect(loadConfig()).rejects.toThrow(
      "AI_ADVISOR_THINKING_LEVEL must be one of",
    );
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

  it("uses default reaction emojis when env vars are unset", async () => {
    delete process.env.JUNIOR_PROCESSING_REACTION;
    delete process.env.JUNIOR_COMPLETED_REACTION;

    const { botConfig } = await loadConfig();
    expect(botConfig.processingReactionEmoji).toBe("eyes");
    expect(botConfig.completedReactionEmoji).toBe("white_check_mark");
  });

  it("uses JUNIOR_PROCESSING_REACTION and JUNIOR_COMPLETED_REACTION when configured", async () => {
    process.env.JUNIOR_PROCESSING_REACTION = "hourglass_flowing_sand";
    process.env.JUNIOR_COMPLETED_REACTION = ":tada:";

    const { botConfig } = await loadConfig();
    expect(botConfig.processingReactionEmoji).toBe("hourglass_flowing_sand");
    expect(botConfig.completedReactionEmoji).toBe("tada");
  });

  it("throws at config load when JUNIOR_PROCESSING_REACTION is not a valid emoji name", async () => {
    process.env.JUNIOR_PROCESSING_REACTION = "not valid emoji!";

    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_PROCESSING_REACTION must be a valid Slack emoji name",
    );
  });

  it("throws at config load when JUNIOR_COMPLETED_REACTION is not a valid emoji name", async () => {
    process.env.JUNIOR_COMPLETED_REACTION = "not valid emoji!";

    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_COMPLETED_REACTION must be a valid Slack emoji name",
    );
  });

  it("uses default AGENT_TURN_TIMEOUT_MS when env var is unset", async () => {
    delete process.env.AGENT_TURN_TIMEOUT_MS;
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });

  it("uses AGENT_TURN_TIMEOUT_MS from env var when valid", async () => {
    process.env.AGENT_TURN_TIMEOUT_MS = "240000";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(240000);
  });

  it("falls back to default AGENT_TURN_TIMEOUT_MS when env var is invalid", async () => {
    process.env.AGENT_TURN_TIMEOUT_MS = "not-a-number";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });

  it("caps AGENT_TURN_TIMEOUT_MS to configured max", async () => {
    process.env.AGENT_TURN_TIMEOUT_MS = "999999";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(280000);
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
