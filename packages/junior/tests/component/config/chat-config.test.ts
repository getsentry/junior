import { describe, expect, it } from "vitest";
import { loadConfig, type ConfigInput } from "@/config";

const TEST_DATABASE_URL = "postgres://user:pass@pooled.example.test/neon";
const ENCRYPTION_ENV = {
  JUNIOR_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString("base64")}`,
};
/** The env every case needs. Each case adds only the vars it sets. */
const BASE_ENV = { ...ENCRYPTION_ENV, DATABASE_URL: TEST_DATABASE_URL };

describe("chat config", () => {
  it("uses AI_MODEL for fastModelId when AI_FAST_MODEL is unset", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_MODEL: "anthropic/claude-opus-4.6" },
    }).bot;
    expect(botConfig.modelId).toBe("anthropic/claude-opus-4.6");
    expect(botConfig.fastModelId).toBe("anthropic/claude-opus-4.6");
  });

  it("prefers AI_FAST_MODEL over AI_MODEL for fastModelId", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        AI_MODEL: "anthropic/claude-opus-4.6",
        AI_FAST_MODEL: "anthropic/claude-haiku-4.5",
      },
    }).bot;
    expect(botConfig.fastModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("uses Luna as the default fast model when AI_MODEL and AI_FAST_MODEL are unset", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.fastModelId).toBe("openai/gpt-6-luna");
  });

  it("uses Luna for Guardian when no override is configured", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        AI_MODEL: "anthropic/claude-opus-4.6",
        AI_FAST_MODEL: "anthropic/claude-haiku-4.5",
      },
    }).bot;
    expect(botConfig.guardianModelId).toBe("openai/gpt-6-luna");
  });

  it("uses the configured Guardian model override", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        AI_FAST_MODEL: "anthropic/claude-haiku-4.5",
        AI_GUARDIAN_MODEL: "openai/gpt-5.4",
      },
    }).bot;
    expect(botConfig.guardianModelId).toBe("openai/gpt-5.4");
  });

  it("uses the default main model when AI_MODEL is unset", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.modelId).toBe("anthropic/claude-opus-5.5");
  });

  it("uses high reasoning by default", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.reasoningLevel).toBe("high");
  });

  it("uses an explicitly configured reasoning level", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_REASONING_LEVEL: "xhigh" },
    }).bot;
    expect(botConfig.reasoningLevel).toBe("xhigh");
  });

  it("trims an explicitly configured reasoning level", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_REASONING_LEVEL: "  xhigh  " },
    }).bot;
    expect(botConfig.reasoningLevel).toBe("xhigh");
  });

  it("rejects an invalid configured reasoning level", () => {
    expect(() =>
      loadConfig({ env: { ...BASE_ENV, AI_REASONING_LEVEL: "adaptive" } }),
    ).toThrow("Invalid option");
  });

  it("uses the default embedding model when AI_EMBEDDING_MODEL is unset", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.embeddingModelId).toBe("openai/text-embedding-3-small");
  });

  it("uses AI_EMBEDDING_MODEL when configured", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_EMBEDDING_MODEL: "openai/text-embedding-3-large" },
    }).bot;
    expect(botConfig.embeddingModelId).toBe("openai/text-embedding-3-large");
  });

  it("uses Luna as the default web search model when AI_WEB_SEARCH_MODEL is blank", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_WEB_SEARCH_MODEL: "   " },
    }).bot;
    expect(botConfig.webSearchModelId).toBe("openai/gpt-6-luna");
  });

  it("uses AI_WEB_SEARCH_MODEL when configured", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        AI_WEB_SEARCH_MODEL: " anthropic/claude-sonnet-4.6 ",
      },
    }).bot;
    expect(botConfig.webSearchModelId).toBe("anthropic/claude-sonnet-4.6");
  });

  it("leaves the refusal fallback model unset by default", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.refusalFallbackModelId).toBeUndefined();
  });

  it("uses AI_REFUSAL_FALLBACK_MODEL when configured", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_REFUSAL_FALLBACK_MODEL: " openai/gpt-6-astra " },
    }).bot;
    expect(botConfig.refusalFallbackModelId).toBe("openai/gpt-6-astra");
  });

  it("throws when AI_WEB_SEARCH_MODEL is not a registered gateway model id", () => {
    expect(() =>
      loadConfig({
        env: {
          ...BASE_ENV,
          AI_WEB_SEARCH_MODEL: "openai/search-model-not-real",
        },
      }),
    ).toThrow(/Unknown AI Gateway model id/);
  });

  it("uses the default image generation model when AI_IMAGE_MODEL is blank", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_IMAGE_MODEL: "   " },
    }).bot;
    expect(botConfig.imageGenerationModelId).toBe("openai/gpt-image-2");
  });

  it("uses AI_IMAGE_MODEL when configured", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_IMAGE_MODEL: " openai/dall-e-3 " },
    }).bot;
    expect(botConfig.imageGenerationModelId).toBe("openai/dall-e-3");
  });

  it("reads the standard database URL", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        DATABASE_URL: "postgres://user:pass@pooled.example.test/neon",
      },
    });
    expect(config.sql.databaseUrl).toBe(
      "postgres://user:pass@pooled.example.test/neon",
    );
  });

  it("uses Neon as the default SQL driver", () => {
    const config = loadConfig({
      env: { ...BASE_ENV, DATABASE_URL: TEST_DATABASE_URL },
    });
    expect(config.sql.driver).toBe("neon");
  });

  it("throws when no SQL database URL is configured", () => {
    expect(() => loadConfig({ env: ENCRYPTION_ENV })).toThrow(
      "DATABASE_URL is required",
    );
  });

  it("defaults localhost database URLs to the node-postgres SQL driver", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        DATABASE_URL: "postgres://junior:junior@localhost:54322/junior",
      },
    });
    expect(config.sql.driver).toBe("postgres");
  });

  it("reads the optional node-postgres SQL driver override", () => {
    const config = loadConfig({
      env: { ...BASE_ENV, JUNIOR_DATABASE_DRIVER: " postgres " },
    });
    expect(config.sql.driver).toBe("postgres");
  });

  it("throws when the SQL driver is invalid", () => {
    expect(() =>
      loadConfig({ env: { ...BASE_ENV, JUNIOR_DATABASE_DRIVER: "sqlite" } }),
    ).toThrow("JUNIOR_DATABASE_DRIVER must be postgres or neon");
  });

  it("uses Vercel Blob attachment storage by default", () => {
    const config = loadConfig({ env: BASE_ENV });
    expect(config.attachmentStorage).toEqual({
      provider: "vercel-blob",
    });
  });

  it("reads S3 attachment storage settings", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        JUNIOR_ATTACHMENT_STORAGE_PROVIDER: " s3 ",
        JUNIOR_S3_ENDPOINT: "http://localhost:7070",
        JUNIOR_S3_BUCKET: "junior-attachments",
        JUNIOR_S3_ACCESS_KEY_ID: "junior",
        JUNIOR_S3_SECRET_ACCESS_KEY: "secret",
      },
    });
    expect(config.attachmentStorage).toEqual({
      provider: "s3",
      s3: {
        accessKeyId: "junior",
        bucket: "junior-attachments",
        endpoint: "http://localhost:7070",
        region: "us-east-1",
        secretAccessKey: "secret",
      },
    });
  });

  it("throws when S3 attachment storage is missing a setting", () => {
    expect(() =>
      loadConfig({
        env: {
          ...BASE_ENV,
          JUNIOR_ATTACHMENT_STORAGE_PROVIDER: "s3",
          JUNIOR_S3_ENDPOINT: "http://localhost:7070",
          JUNIOR_S3_ACCESS_KEY_ID: "junior",
          JUNIOR_S3_SECRET_ACCESS_KEY: "secret",
        },
      }),
    ).toThrow(
      "JUNIOR_S3_BUCKET is required when JUNIOR_ATTACHMENT_STORAGE_PROVIDER is s3",
    );
  });

  it("throws when the attachment storage provider is invalid", () => {
    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, JUNIOR_ATTACHMENT_STORAGE_PROVIDER: "gcs" },
      }),
    ).toThrow(
      "JUNIOR_ATTACHMENT_STORAGE_PROVIDER must be vercel-blob, s3, or memory",
    );
  });

  it("reads a Vercel Queues API URL for a local queue server", () => {
    expect(loadConfig({ env: BASE_ENV }).queue).toEqual({});

    expect(
      loadConfig({
        env: { ...BASE_ENV, JUNIOR_QUEUE_API_URL: "http://127.0.0.1:3100" },
      }).queue,
    ).toEqual({
      apiUrl: "http://127.0.0.1:3100",
    });

    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, JUNIOR_QUEUE_API_URL: "localhost:3100" },
      }),
    ).toThrow("JUNIOR_QUEUE_API_URL must be an http or https URL");
  });

  it("resolves the base URL from the host option, then JUNIOR_BASE_URL, then Vercel", () => {
    const vercelEnv = {
      ...BASE_ENV,
      VERCEL_PROJECT_PRODUCTION_URL: " junior.example.com ",
      VERCEL_URL: "junior-abc123.vercel.app",
    };
    const baseUrl = (env: Record<string, string>, options?: ConfigInput) =>
      loadConfig({ env, options }).deployment.baseUrl;

    expect(baseUrl(BASE_ENV)).toBeUndefined();
    expect(
      baseUrl({ ...BASE_ENV, VERCEL_URL: "junior-abc123.vercel.app" }),
    ).toBe("https://junior-abc123.vercel.app");
    expect(baseUrl(vercelEnv)).toBe("https://junior.example.com");
    expect(
      baseUrl({ ...vercelEnv, JUNIOR_BASE_URL: " http://localhost:3000/ " }),
    ).toBe("http://localhost:3000/");
    expect(
      baseUrl(
        { ...vercelEnv, JUNIOR_BASE_URL: "http://localhost:3000" },
        { deployment: { configuredBaseUrl: "https://dashboard.example.com" } },
      ),
    ).toBe("https://dashboard.example.com");
  });

  it("enables conversation work by default", () => {
    const config = loadConfig({ env: BASE_ENV });
    expect(config.conversationWorkEnabled).toBe(true);
  });

  it("disables conversation work when configured", () => {
    const config = loadConfig({
      env: { ...BASE_ENV, JUNIOR_CONVERSATION_WORK_ENABLED: "false" },
    });
    expect(config.conversationWorkEnabled).toBe(false);
  });

  it("enables cache warming and compaction on idle unless their kill switches are off", () => {
    expect(loadConfig({ env: BASE_ENV })).toMatchObject({
      cacheWarmingEnabled: true,
      idleCompactionEnabled: true,
    });
    expect(
      loadConfig({
        env: {
          ...BASE_ENV,
          JUNIOR_CACHE_WARMING_ENABLED: "false",
          JUNIOR_IDLE_COMPACTION_ENABLED: "false",
        },
      }),
    ).toMatchObject({
      cacheWarmingEnabled: false,
      idleCompactionEnabled: false,
    });
  });

  it("rejects an invalid conversation work switch", () => {
    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, JUNIOR_CONVERSATION_WORK_ENABLED: "sometimes" },
      }),
    ).toThrow("JUNIOR_CONVERSATION_WORK_ENABLED must be true or false");
  });

  it("uses a 30 second SQL statement timeout by default", () => {
    const config = loadConfig({ env: BASE_ENV });
    expect(config.sql.statementTimeoutMs).toBe(30_000);
  });

  it("reads the configured SQL statement timeout", () => {
    const config = loadConfig({
      env: { ...BASE_ENV, JUNIOR_SQL_STATEMENT_TIMEOUT_MS: "15000" },
    });
    expect(config.sql.statementTimeoutMs).toBe(15_000);
  });

  it("allows the SQL statement timeout to be disabled", () => {
    const config = loadConfig({
      env: { ...BASE_ENV, JUNIOR_SQL_STATEMENT_TIMEOUT_MS: "0" },
    });
    expect(config.sql.statementTimeoutMs).toBe(false);
  });

  it("throws when the SQL statement timeout is invalid", () => {
    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, JUNIOR_SQL_STATEMENT_TIMEOUT_MS: "15 seconds" },
      }),
    ).toThrow("JUNIOR_SQL_STATEMENT_TIMEOUT_MS must be a non-negative integer");
  });

  it("ignores AI_LIGHT_MODEL and keeps using AI_FAST_MODEL", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        AI_MODEL: "anthropic/claude-opus-4.6",
        AI_FAST_MODEL: "anthropic/claude-haiku-4.5",
        AI_LIGHT_MODEL: "openai/gpt-5.4-mini",
      },
    }).bot;
    expect(botConfig.fastModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("uses the shared vision default when AI_VISION_MODEL is absent", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_MODEL: "anthropic/claude-opus-4.6" },
    }).bot;
    expect(botConfig.visionModelId).toBe("openai/gpt-5.6-sol");
  });

  it("disables vision when AI_VISION_MODEL is explicitly empty", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_VISION_MODEL: "" },
    }).bot;
    expect(botConfig.visionModelId).toBeUndefined();
  });

  it("uses AI_VISION_MODEL without falling back to AI_MODEL", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        AI_MODEL: "anthropic/claude-opus-4.6",
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    }).bot;
    expect(botConfig.modelId).toBe("anthropic/claude-opus-4.6");
    expect(botConfig.visionModelId).toBe("openai/gpt-5.4");
  });

  it("uses a 400k model context window cap by default", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.contextWindowTokens).toBe(400_000);
  });

  it("reads model context window cap overrides", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AI_MODEL_CONTEXT_WINDOW_TOKENS: "200000" },
    }).bot;
    expect(botConfig.contextWindowTokens).toBe(200000);
  });

  it("throws when model context window overrides are invalid", () => {
    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, AI_MODEL_CONTEXT_WINDOW_TOKENS: "0" },
      }),
    ).toThrow("AI_MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer");
  });

  it("throws at config load when AI_MODEL is not a registered gateway model id", () => {
    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, AI_MODEL: "openai/gpt-definitely-not-real" },
      }),
    ).toThrow(/Unknown AI Gateway model id/);
  });

  it("uses the default assistant loading messages when unset", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.loadingMessages.length).toBeGreaterThan(0);
  });

  it("uses JUNIOR_LOADING_MESSAGES when configured", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        JUNIOR_LOADING_MESSAGES: JSON.stringify([
          "Consulting the orb",
          "Bribing the gremlins",
        ]),
      },
    }).bot;
    expect(botConfig.loadingMessages).toEqual([
      "Consulting the orb",
      "Bribing the gremlins",
    ]);
  });

  it("throws when JUNIOR_LOADING_MESSAGES is not a JSON string array", () => {
    expect(() =>
      loadConfig({
        env: { ...BASE_ENV, JUNIOR_LOADING_MESSAGES: '{"nope":true}' },
      }),
    ).toThrow("JUNIOR_LOADING_MESSAGES must be a JSON array of strings");
  });

  it("uses default reaction emojis", () => {
    const config = loadConfig({ env: BASE_ENV });
    expect(config.slack.processingReactionEmoji).toBe("eyes");
    expect(config.slack.completedReactionEmoji).toBe("white_check_mark");
  });

  it("sets max slices per turn from core config", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.maxSlicesPerTurn).toBe(100);
  });

  it("sets max tool calls per turn from core config", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.maxToolCallsPerTurn).toBe(1000);
  });

  it("sets max turn cost from core config", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.maxTurnCostUsd).toBe(100);
  });

  it("sets max consecutive automated turns from core config", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.maxConsecutiveAutomatedTurns).toBe(25);
  });

  it("sets the event automation run limit from core config", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.maxEventAutomationRuns).toBe(10);
    expect(botConfig.eventAutomationRunWindowMs).toBe(60_000);
  });

  it("uses default AGENT_TURN_TIMEOUT_MS when env var is unset", () => {
    const botConfig = loadConfig({ env: BASE_ENV }).bot;
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });

  it("uses AGENT_TURN_TIMEOUT_MS from env var when valid", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AGENT_TURN_TIMEOUT_MS: "240000" },
    }).bot;
    expect(botConfig.turnTimeoutMs).toBe(240000);
  });

  it("falls back to default AGENT_TURN_TIMEOUT_MS when env var is invalid", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AGENT_TURN_TIMEOUT_MS: "not-a-number" },
    }).bot;
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });

  it("caps AGENT_TURN_TIMEOUT_MS to configured max", () => {
    const botConfig = loadConfig({
      env: { ...BASE_ENV, AGENT_TURN_TIMEOUT_MS: "999999" },
    }).bot;
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });

  it("ignores legacy host duration environment variables", () => {
    const botConfig = loadConfig({
      env: {
        ...BASE_ENV,
        FUNCTION_MAX_DURATION_SECONDS: "500",
        QUEUE_CALLBACK_MAX_DURATION_SECONDS: "600",
        AGENT_TURN_TIMEOUT_MS: "999999",
      },
    }).bot;
    expect(botConfig.turnTimeoutMs).toBe(280000);
  });
});

describe("loadConfig", () => {
  it("prefers host options over env", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        AI_MODEL: "anthropic/claude-opus-4.6",
        JUNIOR_SQL_STATEMENT_TIMEOUT_MS: "15000",
      },
      options: {
        bot: { modelId: "openai/gpt-5.4" },
        functionMaxDurationSeconds: 800,
      },
    });

    expect(config.bot.modelId).toBe("openai/gpt-5.4");
    expect(config.bot.fastModelId).toBe("anthropic/claude-opus-4.6");
    expect(config.sql.statementTimeoutMs).toBe(15_000);
    expect(config.bot.turnTimeoutMs).toBe(720_000);
  });

  it("replaces env attachment storage when options pick another provider", () => {
    const config = loadConfig({
      env: {
        ...BASE_ENV,
        JUNIOR_ATTACHMENT_STORAGE_PROVIDER: "s3",
        JUNIOR_S3_ACCESS_KEY_ID: "junior",
        JUNIOR_S3_BUCKET: "junior-attachments",
        JUNIOR_S3_ENDPOINT: "http://localhost:7070",
        JUNIOR_S3_SECRET_ACCESS_KEY: "secret",
      },
      options: { attachmentStorage: { provider: "memory" } },
    });

    expect(config.attachmentStorage).toEqual({ provider: "memory" });
  });

  it("reads no env by default and requires only the encryption keys and database URL", () => {
    expect(() => loadConfig()).toThrow("JUNIOR_ENCRYPTION_KEYS is required");
    expect(() => loadConfig({ env: ENCRYPTION_ENV })).toThrow(
      /^DATABASE_URL is required$/,
    );
    expect(
      loadConfig({
        env: ENCRYPTION_ENV,
        options: { sql: { databaseUrl: TEST_DATABASE_URL } },
      }).bot.modelId,
    ).toBe("anthropic/claude-opus-5.5");
  });

  it("names the field and its env var in a schema error", () => {
    expect(() =>
      loadConfig({
        env: BASE_ENV,
        options: { bot: { contextWindowTokens: 0 } },
      }),
    ).toThrow(/^bot\.contextWindowTokens \(AI_MODEL_CONTEXT_WINDOW_TOKENS\): /);
  });

  it("applies createApp limits over env and only caps the turn timeout", () => {
    const { bot } = loadConfig({
      env: { ...BASE_ENV, AI_MODEL_CONTEXT_WINDOW_TOKENS: "200000" },
      options: {
        limits: {
          contextWindowTokens: 2_000,
          eventAutomationRunLimit: { maxRuns: 2 },
          turnTimeoutMs: 5_000,
        },
      },
    });

    expect(bot).toMatchObject({
      contextWindowTokens: 2_000,
      eventAutomationRunWindowMs: 60_000,
      maxEventAutomationRuns: 2,
      turnTimeoutMs: 5_000,
    });
  });

  it("names the createApp option in an option error", () => {
    expect(() =>
      loadConfig({
        env: BASE_ENV,
        options: { limits: { maxSlicesPerTurn: 0 } },
      }),
    ).toThrow(/^limits\.maxSlicesPerTurn must be a positive integer$/);
    expect(() =>
      loadConfig({ env: BASE_ENV, options: { bot: { userName: " " } } }),
    ).toThrow(/^botName must not be empty$/);
  });
});

describe("Slack reaction emoji options", () => {
  const slackConfig = (slack: ConfigInput["slack"]) =>
    loadConfig({ env: BASE_ENV, options: { slack } }).slack;

  it("overrides processingReactionEmoji when provided", () => {
    expect(
      slackConfig({ processingReactionEmoji: "jr-thinking" })
        .processingReactionEmoji,
    ).toBe("jr-thinking");
  });

  it("overrides completedReactionEmoji when provided", () => {
    expect(
      slackConfig({ completedReactionEmoji: "jr-done" }).completedReactionEmoji,
    ).toBe("jr-done");
  });

  it("normalizes colon-wrapped emoji names", () => {
    expect(
      slackConfig({ processingReactionEmoji: ":tada:" })
        .processingReactionEmoji,
    ).toBe("tada");
  });

  it("throws when override emoji name is invalid", () => {
    expect(() =>
      slackConfig({ processingReactionEmoji: "not valid emoji!" }),
    ).toThrow("processingReactionEmoji must be a valid Slack emoji name");
  });

  it("leaves unspecified fields unchanged", () => {
    expect(
      slackConfig({ processingReactionEmoji: "jr-thinking" })
        .completedReactionEmoji,
    ).toBe("white_check_mark");
  });
});
