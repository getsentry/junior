import { describe, expect, it } from "vitest";
import { juniorVercelConfig } from "@/vercel";

describe("juniorVercelConfig", () => {
  it("returns config with framework hono and default options", () => {
    const config = juniorVercelConfig();

    expect(config.framework).toBe("hono");
    expect(config.buildCommand).toBe("pnpm build");

    const fn = (config.functions as Record<string, Record<string, unknown>>)[
      "server.ts"
    ];
    expect(fn.maxDuration).toBe(800);
  });

  it("respects custom entrypoint and maxDuration", () => {
    const config = juniorVercelConfig({
      entrypoint: "api/index.ts",
      maxDuration: 300,
    });

    const fn = (config.functions as Record<string, Record<string, unknown>>)[
      "api/index.ts"
    ];
    expect(fn.maxDuration).toBe(300);
  });

  it("omits buildCommand when set to null", () => {
    const config = juniorVercelConfig({ buildCommand: null });

    expect(config.buildCommand).toBeUndefined();
  });
});
