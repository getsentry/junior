import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";
import { withJunior } from "@/next-config";

async function resolveConfig(config: NextConfig | ((phase: string, ctx: { defaultConfig: NextConfig }) => Promise<NextConfig> | NextConfig)): Promise<NextConfig> {
  if (typeof config === "function") {
    return await config("phase-production-build", { defaultConfig: {} });
  }

  return config;
}

describe("withJunior", () => {
  it("merges junior defaults into plain Next config", async () => {
    const config = await resolveConfig(withJunior(
      {
        serverExternalPackages: ["existing-package"]
      },
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    ) as NextConfig);

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "existing-package",
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@chat-adapter/slack",
        "@slack/web-api"
      ])
    );
    expect(config.outputFileTracingIncludes?.["/*"]).toEqual(
      expect.arrayContaining(["./my-data/**/*", "./my-skills/**/*", "./my-plugins/**/*"])
    );
  });

  it("wraps async Next config factories", async () => {
    const wrapped = withJunior(
      async () => ({
        typedRoutes: true
      }),
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    );

    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new Error("Expected withJunior to return a config factory");
    }

    const resolved = await resolveConfig(wrapped);

    expect(resolved.typedRoutes).toBe(true);
    expect(resolved.outputFileTracingIncludes?.["/*"]).toEqual(
      expect.arrayContaining(["./my-data/**/*", "./my-skills/**/*", "./my-plugins/**/*"])
    );
    expect(resolved.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@chat-adapter/slack",
        "@slack/web-api"
      ])
    );
  });

  it("merges existing global tracing includes instead of overwriting them", async () => {
    const config = await resolveConfig(withJunior(
      {
        outputFileTracingIncludes: {
          "/*": ["./existing/**/*"],
          "/other/**": ["./other/**/*"]
        }
      },
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    ) as NextConfig);

    expect(config.outputFileTracingIncludes?.["/*"]).toEqual(
      expect.arrayContaining(["./existing/**/*", "./my-data/**/*", "./my-skills/**/*", "./my-plugins/**/*"])
    );
    expect(config.outputFileTracingIncludes?.["/other/**"]).toEqual(["./other/**/*"]);
  });

  it("deduplicates serverExternalPackages when consumer already includes defaults", async () => {
    const config = await resolveConfig(withJunior(
      {
        serverExternalPackages: ["@vercel/sandbox", "custom-package"]
      },
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    ) as NextConfig);

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@chat-adapter/slack",
        "@slack/web-api",
        "custom-package"
      ])
    );
    expect(config.serverExternalPackages?.filter((pkg) => pkg === "@vercel/sandbox")).toHaveLength(1);
  });

  it("preserves consumer transpilePackages", async () => {
    const config = await resolveConfig(withJunior({
      transpilePackages: ["other-package"]
    }) as NextConfig);

    expect(config.transpilePackages).toEqual(["other-package"]);
  });

  it("accepts pre-wrapped configs without changing behavior", async () => {
    const config = await resolveConfig(withJunior({ typedRoutes: true }) as NextConfig);

    expect(config.typedRoutes).toBe(true);
    expect(config.transpilePackages).toBeUndefined();
  });
});
