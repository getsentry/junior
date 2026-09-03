import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logWarn: mocks.logWarn,
}));

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = "postgres://user:pass@pooled.example.test/neon";

async function loadConfig() {
  vi.resetModules();
  return import("@/chat/config");
}

describe("chat config", () => {
  beforeEach(() => {
    mocks.logWarn.mockClear();
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    delete process.env.JUNIOR_DATABASE_DRIVER;
    delete process.env.JUNIOR_SQL_STATEMENT_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("warns for deprecated profile environment variables", async () => {
    process.env.AI_MODEL = "xai/grok-4.5";
    process.env.AI_HANDOFF_MODEL = "openai/gpt-5.6-sol";
    process.env.AI_MODEL_PROFILES = JSON.stringify({
      coding: "openai/gpt-5.4",
    });

    await loadConfig();

    expect(mocks.logWarn.mock.calls).toEqual(
      ["AI_MODEL", "AI_HANDOFF_MODEL", "AI_MODEL_PROFILES"].map((envName) => [
        "config.profile_env.deprecated",
        {
          "app.config.env_name": envName,
          "app.config.replacement": "createApp({ defaultProfile, profiles })",
        },
      ]),
    );
  });

  it("uses AI_MODEL for fastModelId when AI_FAST_MODEL is unset", async () => {
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    delete process.env.AI_FAST_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles.standard).toEqual({
      modelId: "anthropic/claude-opus-4.6",
      description: expect.stringContaining("Use for default assistant work"),
    });
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
    expect(botConfig.fastModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("uses Luna for Guardian when no override is configured", async () => {
    process.env.AI_MODEL = "anthropic/claude-opus-4.6";
    process.env.AI_FAST_MODEL = "anthropic/claude-haiku-4.5";
    delete process.env.AI_GUARDIAN_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.guardianModelId).toBe("openai/gpt-5.6-luna");
  });

  it("uses the configured Guardian model override", async () => {
    process.env.AI_FAST_MODEL = "anthropic/claude-haiku-4.5";
    process.env.AI_GUARDIAN_MODEL = "openai/gpt-5.4";

    const { botConfig } = await loadConfig();
    expect(botConfig.guardianModelId).toBe("openai/gpt-5.4");
  });

  it("uses the default main model when AI_MODEL is unset", async () => {
    delete process.env.AI_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles.standard).toEqual({
      modelId: "xai/grok-4.5",
      description: expect.stringContaining("Use for default assistant work"),
    });
  });

  it("leaves reasoning unset by default", async () => {
    delete process.env.AI_REASONING_LEVEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.reasoningLevel).toBeUndefined();
  });

  it("uses an explicitly configured reasoning level", async () => {
    process.env.AI_REASONING_LEVEL = "xhigh";

    const { botConfig } = await loadConfig();
    expect(botConfig.reasoningLevel).toBe("xhigh");
  });

  it("trims an explicitly configured reasoning level", async () => {
    process.env.AI_REASONING_LEVEL = "  xhigh  ";

    const { botConfig } = await loadConfig();
    expect(botConfig.reasoningLevel).toBe("xhigh");
  });

  it("rejects an invalid configured reasoning level", async () => {
    process.env.AI_REASONING_LEVEL = "adaptive";

    await expect(loadConfig()).rejects.toThrow("Invalid option");
  });

  it("uses gpt-5.6-sol for the env handoff profile", async () => {
    delete process.env.AI_HANDOFF_MODEL;
    delete process.env.AI_MODEL_PROFILES;

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles).toEqual({
      standard: {
        modelId: "xai/grok-4.5",
        description: expect.stringContaining("Use for default assistant work"),
      },
      handoff: {
        modelId: "openai/gpt-5.6-sol",
        description: expect.stringContaining(
          "Use for coding and difficult multi-step work",
        ),
        reasoningLevel: "high",
      },
    });
  });

  it("uses AI_HANDOFF_MODEL for the env handoff profile", async () => {
    process.env.AI_HANDOFF_MODEL = "openai/gpt-5.4";

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles.handoff).toEqual({
      modelId: "openai/gpt-5.4",
      description: expect.stringContaining(
        "Use for coding and difficult multi-step work",
      ),
      reasoningLevel: "high",
    });
  });

  it("adds named profiles from AI_MODEL_PROFILES", async () => {
    process.env.AI_MODEL_PROFILES = JSON.stringify({
      coding: "openai/gpt-5.4",
      research: "anthropic/claude-opus-4.6",
    });

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles).toEqual({
      standard: {
        modelId: "xai/grok-4.5",
        description: expect.stringContaining("Use for default assistant work"),
      },
      handoff: {
        modelId: "openai/gpt-5.6-sol",
        description: expect.stringContaining(
          "Use for coding and difficult multi-step work",
        ),
        reasoningLevel: "high",
      },
      coding: { modelId: "openai/gpt-5.4" },
      research: { modelId: "anthropic/claude-opus-4.6" },
    });
  });

  it("accepts AI_MODEL_PROFILES objects with task-fit descriptions", async () => {
    process.env.AI_MODEL_PROFILES = JSON.stringify({
      coding: {
        modelId: "openai/gpt-5.4",
        description: "Implementation and debugging work.",
        reasoningLevel: "high",
      },
    });

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles.coding).toEqual({
      modelId: "openai/gpt-5.4",
      description: "Implementation and debugging work.",
      reasoningLevel: "high",
    });
  });

  it("lets AI_MODEL_PROFILES override standard and handoff", async () => {
    process.env.AI_MODEL_PROFILES = JSON.stringify({
      standard: "openai/gpt-5.4",
      handoff: "anthropic/claude-opus-4.6",
    });

    const { botConfig } = await loadConfig();
    expect(botConfig.profiles).toEqual({
      standard: { modelId: "openai/gpt-5.4" },
      handoff: { modelId: "anthropic/claude-opus-4.6" },
    });
  });

  it("fails when a durable profile is no longer configured", async () => {
    delete process.env.AI_MODEL_PROFILES;

    const { botConfig } = await loadConfig();
    const { modelIdForProfile, ModelProfileNotConfiguredError } =
      await import("@/chat/model-profile");
    expect(() => modelIdForProfile(botConfig, "coding")).toThrowError(
      ModelProfileNotConfiguredError,
    );
  });

  it.each([
    ["[]", "must be a JSON object"],
    ['{"Coding":"openai/gpt-5.4"}', "must match"],
    ['{"coding":""}', "must not be empty"],
  ])("rejects invalid AI_MODEL_PROFILES %s", async (value, message) => {
    process.env.AI_MODEL_PROFILES = value;

    await expect(loadConfig()).rejects.toThrow(message);
  });

  it("uses the default embedding model when AI_EMBEDDING_MODEL is unset", async () => {
    delete process.env.AI_EMBEDDING_MODEL;

    const { botConfig } = await loadConfig();
    expect(botConfig.embeddingModelId).toBe("openai/text-embedding-3-small");
  });

  it("uses AI_EMBEDDING_MODEL when configured", async () => {
    process.env.AI_EMBEDDING_MODEL = "openai/text-embedding-3-large";

    const { botConfig } = await loadConfig();
    expect(botConfig.embeddingModelId).toBe("openai/text-embedding-3-large");
  });

  it("uses the default web search model when AI_WEB_SEARCH_MODEL is blank", async () => {
    process.env.AI_WEB_SEARCH_MODEL = "   ";

    const { botConfig } = await loadConfig();
    expect(botConfig.webSearchModelId).toBe("openai/gpt-5.4");
  });

  it("uses AI_WEB_SEARCH_MODEL when configured", async () => {
    process.env.AI_WEB_SEARCH_MODEL = " anthropic/claude-sonnet-4.6 ";

    const { botConfig } = await loadConfig();
    expect(botConfig.webSearchModelId).toBe("anthropic/claude-sonnet-4.6");
  });

  it("throws when AI_WEB_SEARCH_MODEL is not a registered gateway model id", async () => {
    process.env.AI_WEB_SEARCH_MODEL = "openai/search-model-not-real";

    await expect(loadConfig()).rejects.toThrow(/Unknown AI Gateway model id/);
  });

  it("uses the default image generation model when AI_IMAGE_MODEL is blank", async () => {
    process.env.AI_IMAGE_MODEL = "   ";

    const { botConfig } = await loadConfig();
    expect(botConfig.imageGenerationModelId).toBe("google/gemini-3-pro-image");
  });

  it("uses AI_IMAGE_MODEL when configured", async () => {
    process.env.AI_IMAGE_MODEL = " openai/dall-e-3 ";

    const { botConfig } = await loadConfig();
    expect(botConfig.imageGenerationModelId).toBe("openai/dall-e-3");
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

  it("reads the standard database URL", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@pooled.example.test/neon";

    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.databaseUrl).toBe(
      "postgres://user:pass@pooled.example.test/neon",
    );
  });

  it("uses Neon as the default SQL driver", async () => {
    delete process.env.JUNIOR_DATABASE_DRIVER;
    process.env.DATABASE_URL = TEST_DATABASE_URL;

    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.driver).toBe("neon");
  });

  it("throws when no SQL database URL is configured", async () => {
    delete process.env.DATABASE_URL;

    await expect(loadConfig()).rejects.toThrow("DATABASE_URL is required");
  });

  it("defaults localhost database URLs to the node-postgres SQL driver", async () => {
    delete process.env.JUNIOR_DATABASE_DRIVER;
    process.env.DATABASE_URL =
      "postgres://junior:junior@localhost:54322/junior";

    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.driver).toBe("postgres");
  });

  it("reads the optional node-postgres SQL driver override", async () => {
    process.env.JUNIOR_DATABASE_DRIVER = " postgres ";

    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.driver).toBe("postgres");
  });

  it("throws when the SQL driver is invalid", async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JUNIOR_DATABASE_DRIVER = "sqlite";

    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_DATABASE_DRIVER must be postgres or neon",
    );
  });

  it("enables conversation work by default", async () => {
    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().conversationWorkEnabled).toBe(true);
  });

  it("disables conversation work when configured", async () => {
    process.env.JUNIOR_CONVERSATION_WORK_ENABLED = "false";
    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().conversationWorkEnabled).toBe(false);
  });

  it("rejects an invalid conversation work switch", async () => {
    process.env.JUNIOR_CONVERSATION_WORK_ENABLED = "sometimes";
    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_CONVERSATION_WORK_ENABLED must be true or false",
    );
  });

  it("uses a 30 second SQL statement timeout by default", async () => {
    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.statementTimeoutMs).toBe(30_000);
  });

  it("reads the configured SQL statement timeout", async () => {
    process.env.JUNIOR_SQL_STATEMENT_TIMEOUT_MS = "15000";
    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.statementTimeoutMs).toBe(15_000);
  });

  it("allows the SQL statement timeout to be disabled", async () => {
    process.env.JUNIOR_SQL_STATEMENT_TIMEOUT_MS = "0";
    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().sql.statementTimeoutMs).toBe(false);
  });

  it("throws when the SQL statement timeout is invalid", async () => {
    process.env.JUNIOR_SQL_STATEMENT_TIMEOUT_MS = "15 seconds";
    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_SQL_STATEMENT_TIMEOUT_MS must be a non-negative integer",
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
    expect(botConfig.profiles.standard).toEqual({
      modelId: "anthropic/claude-opus-4.6",
      description: expect.stringContaining("Use for default assistant work"),
    });
    expect(botConfig.visionModelId).toBe("openai/gpt-5.4");
  });

  it("uses a 400k model context window cap by default", async () => {
    delete process.env.AI_MODEL_CONTEXT_WINDOW_TOKENS;

    const { botConfig } = await loadConfig();
    expect(botConfig.contextWindowTokens).toBe(400_000);
  });

  it("reads model context window cap overrides", async () => {
    process.env.AI_MODEL_CONTEXT_WINDOW_TOKENS = "200000";

    const { botConfig } = await loadConfig();
    expect(botConfig.contextWindowTokens).toBe(200000);
  });

  it("throws when model context window overrides are invalid", async () => {
    process.env.AI_MODEL_CONTEXT_WINDOW_TOKENS = "0";

    await expect(loadConfig()).rejects.toThrow(
      "AI_MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer",
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

  it("uses default reaction emojis", async () => {
    const { getChatConfig } = await loadConfig();
    expect(getChatConfig().slack.processingReactionEmoji).toBe("eyes");
    expect(getChatConfig().slack.completedReactionEmoji).toBe(
      "white_check_mark",
    );
  });

  it("defaults cross-actor mid-run messages to follow-up", async () => {
    delete process.env.JUNIOR_CROSS_ACTOR_MID_RUN_MODE;
    const { botConfig } = await loadConfig();
    expect(botConfig.crossActorMidRunMode).toBe("follow_up");
  });

  it("supports collaborative cross-actor steering", async () => {
    process.env.JUNIOR_CROSS_ACTOR_MID_RUN_MODE = "steer";
    const { botConfig } = await loadConfig();
    expect(botConfig.crossActorMidRunMode).toBe("steer");
  });

  it("rejects unsupported cross-actor mid-run modes", async () => {
    process.env.JUNIOR_CROSS_ACTOR_MID_RUN_MODE = "router";
    await expect(loadConfig()).rejects.toThrow(
      "JUNIOR_CROSS_ACTOR_MID_RUN_MODE must be follow_up or steer",
    );
  });

  it("sets max slices per turn from core config", async () => {
    const { botConfig } = await loadConfig();
    expect(botConfig.maxSlicesPerTurn).toBe(100);
  });

  it("sets max tool calls per turn from core config", async () => {
    const { botConfig } = await loadConfig();
    expect(botConfig.maxToolCallsPerTurn).toBe(150);
  });

  it("sets max consecutive automated turns from core config", async () => {
    const { botConfig } = await loadConfig();
    expect(botConfig.maxConsecutiveAutomatedTurns).toBe(25);
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

  it("ignores legacy host duration environment variables", async () => {
    process.env.FUNCTION_MAX_DURATION_SECONDS = "500";
    process.env.QUEUE_CALLBACK_MAX_DURATION_SECONDS = "600";
    process.env.AGENT_TURN_TIMEOUT_MS = "999999";
    const { botConfig } = await loadConfig();
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });
});

describe("setSlackReactionConfig", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("overrides processingReactionEmoji when provided", async () => {
    const { getChatConfig, setSlackReactionConfig } = await loadConfig();
    setSlackReactionConfig({ processingReactionEmoji: "jr-thinking" });
    expect(getChatConfig().slack.processingReactionEmoji).toBe("jr-thinking");
  });

  it("overrides completedReactionEmoji when provided", async () => {
    const { getChatConfig, setSlackReactionConfig } = await loadConfig();
    setSlackReactionConfig({ completedReactionEmoji: "jr-done" });
    expect(getChatConfig().slack.completedReactionEmoji).toBe("jr-done");
  });

  it("normalizes colon-wrapped emoji names", async () => {
    const { getChatConfig, setSlackReactionConfig } = await loadConfig();
    setSlackReactionConfig({ processingReactionEmoji: ":tada:" });
    expect(getChatConfig().slack.processingReactionEmoji).toBe("tada");
  });

  it("throws when override emoji name is invalid", async () => {
    const { setSlackReactionConfig } = await loadConfig();
    expect(() =>
      setSlackReactionConfig({ processingReactionEmoji: "not valid emoji!" }),
    ).toThrow("processingReactionEmoji must be a valid Slack emoji name");
  });

  it("leaves unspecified fields unchanged", async () => {
    const { getChatConfig, setSlackReactionConfig } = await loadConfig();
    const original = getChatConfig().slack.completedReactionEmoji;
    setSlackReactionConfig({ processingReactionEmoji: "jr-thinking" });
    expect(getChatConfig().slack.completedReactionEmoji).toBe(original);
  });
});
