import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";

const originalExtraPluginRoots = process.env.JUNIOR_EXTRA_PLUGIN_ROOTS;

function useFixturePlugins(): void {
  process.env.JUNIOR_EXTRA_PLUGIN_ROOTS = path.resolve(
    "tests/fixtures/plugins",
  );
}

afterEach(() => {
  if (originalExtraPluginRoots === undefined) {
    delete process.env.JUNIOR_EXTRA_PLUGIN_ROOTS;
  } else {
    process.env.JUNIOR_EXTRA_PLUGIN_ROOTS = originalExtraPluginRoots;
  }
  vi.doUnmock("#junior/config");
});

describe("createApp", () => {
  it("accepts chat platform enablement in the app initializer", async () => {
    await expect(
      createApp({ enabledPlatforms: ["github"] }),
    ).resolves.toBeDefined();
  });

  it("rejects unsupported chat platforms from the app initializer", async () => {
    await expect(
      createApp({ enabledPlatforms: ["email" as never] }),
    ).rejects.toThrow("enabledPlatforms must contain only: slack, github");
  });

  it("accepts per-platform plugin and skill configuration", async () => {
    useFixturePlugins();

    const app = await createApp({
      platforms: {
        github: {
          plugins: ["eval-auth"],
          skills: ["eval-auth"],
          configDefaults: {
            "github.repo": "acme/junior",
          },
        },
      },
    });

    expect(
      (
        await app.request("/api/internal/turn-resume", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("accepts an explicit platform with no plugins or skills", async () => {
    const app = await createApp({
      platforms: {
        github: {
          plugins: [],
          skills: [],
        },
      },
    });

    expect(
      (
        await app.request("/api/internal/turn-resume", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("normalizes platform keys before resolving their config", async () => {
    const app = await createApp({
      platforms: {
        GitHub: {
          plugins: [],
          skills: [],
        },
      } as never,
    });

    expect(
      (
        await app.request("/api/internal/turn-resume", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("lets runtime platform options override build-time platform config", async () => {
    vi.doMock("#junior/config", () => ({
      pluginPackages: [],
      enabledPlatforms: undefined,
      platforms: {
        slack: {
          plugins: ["missing-provider"],
        },
      },
    }));

    await expect(
      createApp({ enabledPlatforms: ["github"] }),
    ).resolves.toBeDefined();
  });

  it("rejects unknown platform plugin names", async () => {
    useFixturePlugins();

    await expect(
      createApp({
        platforms: {
          github: {
            plugins: ["missing-provider"],
          },
        },
      }),
    ).rejects.toThrow(
      'platforms.github.plugins contains unknown plugin "missing-provider"',
    );
  });

  it("rejects skills owned by disabled platform plugins", async () => {
    useFixturePlugins();

    await expect(
      createApp({
        platforms: {
          github: {
            plugins: ["eval-oauth"],
            skills: ["eval-auth"],
          },
        },
      }),
    ).rejects.toThrow(
      'platforms.github.skills includes "eval-auth" from plugin "eval-auth"',
    );
  });
});
