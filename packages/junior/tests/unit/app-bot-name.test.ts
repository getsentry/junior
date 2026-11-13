import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createApp botName", () => {
  it("overrides JUNIOR_BOT_NAME", async () => {
    vi.stubEnv("JUNIOR_BOT_NAME", "junior");

    await createApp({ botName: " jr ", plugins: defineJuniorPlugins([]) });

    expect(botConfig.userName).toBe("jr");
  });

  it("keeps JUNIOR_BOT_NAME when botName is unset", async () => {
    vi.stubEnv("JUNIOR_BOT_NAME", "junior-example");

    await createApp({ plugins: defineJuniorPlugins([]) });

    expect(botConfig.userName).toBe("junior-example");
  });

  it("rejects an empty botName", async () => {
    await expect(
      createApp({ botName: "  ", plugins: defineJuniorPlugins([]) }),
    ).rejects.toThrow("botName must not be empty");
  });
});
