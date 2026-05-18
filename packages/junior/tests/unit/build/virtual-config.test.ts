import { describe, expect, it } from "vitest";
import { injectVirtualConfig } from "@/build/virtual-config";

describe("virtual Junior config", () => {
  it("exposes plugin packages and enabled chat platforms", () => {
    const nitro = {
      options: {
        virtual: {},
      },
    } as unknown as Parameters<typeof injectVirtualConfig>[0];

    injectVirtualConfig(nitro, {
      enabledPlatforms: ["github"],
      pluginPackages: ["@sentry/junior-github"],
    });

    expect(nitro.options.virtual["#junior/config"]).toBe(
      [
        'export const pluginPackages = ["@sentry/junior-github"];',
        'export const enabledPlatforms = ["github"];',
        "export const platforms = undefined;",
      ].join("\n"),
    );
  });

  it("exposes per-platform plugin configuration", () => {
    const nitro = {
      options: {
        virtual: {},
      },
    } as unknown as Parameters<typeof injectVirtualConfig>[0];

    injectVirtualConfig(nitro, {
      pluginPackages: [],
      platforms: {
        github: {
          plugins: ["sentry"],
          skills: [],
        },
      },
    });

    expect(nitro.options.virtual["#junior/config"]).toBe(
      [
        "export const pluginPackages = [];",
        "export const enabledPlatforms = undefined;",
        'export const platforms = {"github":{"plugins":["sentry"],"skills":[]}};',
      ].join("\n"),
    );
  });
});
