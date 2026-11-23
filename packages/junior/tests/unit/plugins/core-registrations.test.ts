import { describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";

describe("core registrations", () => {
  it("rejects an app plugin that takes a core feature name", async () => {
    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "notifications",
              displayName: "Briefs",
              description: "Plugin that claims a core feature name",
            },
            hooks: {},
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Plugin name "notifications" is reserved for a core feature',
    );
  });
});
