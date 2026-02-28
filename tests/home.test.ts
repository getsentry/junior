import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir, soulPath, skillsDir, loadHomeConfig } from "@/chat/home";

describe("home", () => {
  const originalJuniorHome = process.env.JUNIOR_HOME;

  afterEach(() => {
    if (originalJuniorHome === undefined) {
      delete process.env.JUNIOR_HOME;
    } else {
      process.env.JUNIOR_HOME = originalJuniorHome;
    }
  });

  describe("homeDir", () => {
    it("returns resolved JUNIOR_HOME path", () => {
      process.env.JUNIOR_HOME = "./jr-sentry";
      expect(homeDir()).toBe(path.resolve("./jr-sentry"));
    });

    it("defaults to cwd when JUNIOR_HOME is not set", () => {
      delete process.env.JUNIOR_HOME;
      expect(homeDir()).toBe(process.cwd());
    });
  });

  describe("soulPath", () => {
    it("resolves to SOUL.md inside home dir", () => {
      process.env.JUNIOR_HOME = "/tmp/test-home";
      expect(soulPath()).toBe("/tmp/test-home/SOUL.md");
    });
  });

  describe("skillsDir", () => {
    it("resolves to skills/ inside home dir", () => {
      process.env.JUNIOR_HOME = "/tmp/test-home";
      expect(skillsDir()).toBe("/tmp/test-home/skills");
    });
  });

  describe("loadHomeConfig", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "junior-home-"));
      process.env.JUNIOR_HOME = tempDir;
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("reads config.toml from home dir", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.toml"),
        [
          "[bot]",
          'name = "testbot"',
          "",
          "[ai]",
          'model = "openai/gpt-4"',
          'fast_model = "openai/gpt-3.5-turbo"'
        ].join("\n"),
        "utf8"
      );

      const config = loadHomeConfig();
      expect(config.bot.name).toBe("testbot");
      expect(config.ai.model).toBe("openai/gpt-4");
      expect(config.ai.fast_model).toBe("openai/gpt-3.5-turbo");
    });

    it("uses defaults for missing fields", async () => {
      await fs.writeFile(path.join(tempDir, "config.toml"), "", "utf8");

      const config = loadHomeConfig();
      expect(config.bot.name).toBe("junior");
      expect(config.ai.model).toBe("anthropic/claude-sonnet-4.6");
      expect(config.ai.fast_model).toBe("anthropic/claude-haiku-4-5");
    });
  });
});
