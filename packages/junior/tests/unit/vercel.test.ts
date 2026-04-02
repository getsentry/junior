import { describe, expect, it } from "vitest";
import { juniorVercelConfig } from "@/vercel";

describe("juniorVercelConfig", () => {
  it("returns config with default buildCommand", () => {
    const config = juniorVercelConfig();

    expect(config.buildCommand).toBe("pnpm build");
  });

  it("omits buildCommand when set to null", () => {
    const config = juniorVercelConfig({ buildCommand: null });

    expect(config.buildCommand).toBeUndefined();
  });
});
