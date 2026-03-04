import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";
import { withWorkflow } from "workflow/next";
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
      expect.arrayContaining(["existing-package", "@vercel/sandbox", "bash-tool", "just-bash"])
    );
    expect(config.transpilePackages).toEqual(expect.arrayContaining(["junior"]));
    expect(config.outputFileTracingIncludes?.["/api/**"]).toEqual([
      "./my-data/**/*",
      "./my-skills/**/*",
      "./my-plugins/**/*"
    ]);
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
    expect(resolved.outputFileTracingIncludes?.["/api/**"]).toEqual([
      "./my-data/**/*",
      "./my-skills/**/*",
      "./my-plugins/**/*"
    ]);
    expect(resolved.serverExternalPackages).toEqual(
      expect.arrayContaining(["@vercel/sandbox", "bash-tool", "just-bash"])
    );
    expect(resolved.transpilePackages).toEqual(expect.arrayContaining(["junior"]));
  });

  it("merges existing /api/** tracing includes instead of overwriting them", async () => {
    const config = await resolveConfig(withJunior(
      {
        outputFileTracingIncludes: {
          "/api/**": ["./existing/**/*"],
          "/other/**": ["./other/**/*"]
        }
      },
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    ) as NextConfig);

    expect(config.outputFileTracingIncludes?.["/api/**"]).toEqual([
      "./existing/**/*",
      "./my-data/**/*",
      "./my-skills/**/*",
      "./my-plugins/**/*"
    ]);
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
      expect.arrayContaining(["@vercel/sandbox", "bash-tool", "just-bash", "custom-package"])
    );
    expect(config.serverExternalPackages?.filter((pkg) => pkg === "@vercel/sandbox")).toHaveLength(1);
  });

  it("deduplicates transpilePackages when consumer already transpiles junior", async () => {
    const config = await resolveConfig(withJunior({
      transpilePackages: ["junior", "other-package"]
    }) as NextConfig);

    expect(config.transpilePackages).toEqual(expect.arrayContaining(["junior", "other-package"]));
    expect(config.transpilePackages?.filter((pkg) => pkg === "junior")).toHaveLength(1);
  });

  it("accepts a config already wrapped by withWorkflow without changing behavior", async () => {
    const config = await resolveConfig(
      withJunior(
        withWorkflow({
          typedRoutes: true
        })
      ) as NextConfig
    );

    expect(config.typedRoutes).toBe(true);
    expect(config.transpilePackages).toEqual(expect.arrayContaining(["junior"]));
  });
});
