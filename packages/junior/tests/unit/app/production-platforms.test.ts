import { afterEach, describe, expect, it, vi } from "vitest";

const githubEnvKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_BOT_USERNAME",
] as const;

describe("production platform wiring", () => {
  const originalEnv = Object.fromEntries(
    githubEnvKeys.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const key of githubEnvKeys) {
      const original = originalEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    vi.resetModules();
  });

  it("validates the normalized GitHub mention target before creating the adapter", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    process.env.GITHUB_BOT_USERNAME = "[bot]";
    vi.resetModules();

    const { createProductionBotResolver } =
      await import("@/chat/app/production");
    const getBot = createProductionBotResolver({
      enabledPlatforms: ["github"],
    });

    expect(() => getBot()).toThrow(
      "GitHub adapter requires GITHUB_BOT_USERNAME when GitHub webhook support is enabled",
    );
  });
});
