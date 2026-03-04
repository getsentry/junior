import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";
import { withJunior } from "@/next-config";

describe("withJunior", () => {
  it("merges junior defaults into plain Next config", () => {
    const config = withJunior(
      {
        serverExternalPackages: ["existing-package"]
      },
      { home: "./my-home" }
    ) as NextConfig;

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining(["existing-package", "@vercel/sandbox", "bash-tool", "just-bash"])
    );
    expect(config.outputFileTracingIncludes?.["/api/**"]).toEqual(["./my-home/**/*"]);
  });

  it("wraps async Next config factories", async () => {
    const wrapped = withJunior(
      async () => ({
        typedRoutes: true
      }),
      { home: "./my-home" }
    );

    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new Error("Expected withJunior to return a config factory");
    }

    const resolved = await wrapped("phase-production-build", {
      defaultConfig: {}
    });

    expect(resolved.typedRoutes).toBe(true);
    expect(resolved.outputFileTracingIncludes?.["/api/**"]).toEqual(["./my-home/**/*"]);
    expect(resolved.serverExternalPackages).toEqual(
      expect.arrayContaining(["@vercel/sandbox", "bash-tool", "just-bash"])
    );
  });
});
