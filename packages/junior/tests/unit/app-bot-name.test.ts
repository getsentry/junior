import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";

afterEach(() => {
  vi.doUnmock("#junior/config");
  vi.unstubAllEnvs();
});

describe("createApp bot name", () => {
  it("uses the bot name of the juniorNitro() build over JUNIOR_BOT_NAME", async () => {
    vi.stubEnv("JUNIOR_BOT_NAME", "junior");
    vi.doMock("#junior/config", () => ({
      botName: "jr",
      createDashboardApp: undefined,
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));

    await createApp({ plugins: defineJuniorPlugins([]) });

    expect(botConfig.userName).toBe("jr");
  });

  it("keeps JUNIOR_BOT_NAME without a juniorNitro() build", async () => {
    vi.stubEnv("JUNIOR_BOT_NAME", "junior-example");

    await createApp({ plugins: defineJuniorPlugins([]) });

    expect(botConfig.userName).toBe("junior-example");
  });

  it("rejects the removed botName option", async () => {
    // A JavaScript host can still pass the removed option.
    const options = { botName: "jr", plugins: defineJuniorPlugins([]) };

    await expect(createApp(options)).rejects.toThrow(
      "createApp({ botName }) was removed; set botName in juniorNitro() instead",
    );
  });
});
