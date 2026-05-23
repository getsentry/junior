import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@/app";

const originalPluginPackages = process.env.JUNIOR_PLUGIN_PACKAGES;

afterEach(() => {
  if (originalPluginPackages === undefined) {
    delete process.env.JUNIOR_PLUGIN_PACKAGES;
  } else {
    process.env.JUNIOR_PLUGIN_PACKAGES = originalPluginPackages;
  }
});

describe("createApp plugin config", () => {
  it("fails loudly when the env plugin package fallback is malformed", async () => {
    process.env.JUNIOR_PLUGIN_PACKAGES = "not-json";

    await expect(createApp()).rejects.toThrow(
      "JUNIOR_PLUGIN_PACKAGES must be valid JSON",
    );
  });

  it("fails loudly when the env plugin package fallback is not a package list", async () => {
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify({
      packages: ["@acme/junior-plugin"],
    });

    await expect(createApp()).rejects.toThrow(
      "JUNIOR_PLUGIN_PACKAGES must be a JSON array of package names",
    );
  });

  it("fails loudly when configured plugin package names are empty", async () => {
    await expect(
      createApp({
        plugins: {
          packages: [" "],
        },
      }),
    ).rejects.toThrow("Plugin package names must be non-empty strings");
  });
});
