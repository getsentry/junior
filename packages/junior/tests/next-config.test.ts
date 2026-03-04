import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";
import { withJunior } from "@/next-config";

describe("withJunior", () => {
  it("merges junior defaults into plain Next config", () => {
    const config = withJunior(
      {
        serverExternalPackages: ["existing-package"]
      },
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    ) as NextConfig;

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining(["existing-package", "@vercel/sandbox", "bash-tool", "just-bash"])
    );
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

    const resolved = await wrapped("phase-production-build", {
      defaultConfig: {}
    });

    expect(resolved.typedRoutes).toBe(true);
    expect(resolved.outputFileTracingIncludes?.["/api/**"]).toEqual([
      "./my-data/**/*",
      "./my-skills/**/*",
      "./my-plugins/**/*"
    ]);
    expect(resolved.serverExternalPackages).toEqual(
      expect.arrayContaining(["@vercel/sandbox", "bash-tool", "just-bash"])
    );
  });

  it("merges existing /api/** tracing includes instead of overwriting them", () => {
    const config = withJunior(
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
    ) as NextConfig;

    expect(config.outputFileTracingIncludes?.["/api/**"]).toEqual([
      "./existing/**/*",
      "./my-data/**/*",
      "./my-skills/**/*",
      "./my-plugins/**/*"
    ]);
    expect(config.outputFileTracingIncludes?.["/other/**"]).toEqual(["./other/**/*"]);
  });

  it("deduplicates serverExternalPackages when consumer already includes defaults", () => {
    const config = withJunior(
      {
        serverExternalPackages: ["@vercel/sandbox", "custom-package"]
      },
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins"
      }
    ) as NextConfig;

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining(["@vercel/sandbox", "bash-tool", "just-bash", "custom-package"])
    );
    expect(config.serverExternalPackages?.filter((pkg) => pkg === "@vercel/sandbox")).toHaveLength(1);
  });
});
