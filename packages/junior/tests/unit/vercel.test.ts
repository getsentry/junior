import { describe, expect, it } from "vitest";
import { juniorVercelConfig } from "@/vercel";

describe("juniorVercelConfig", () => {
  it("returns config with default buildCommand", () => {
    const config = juniorVercelConfig();

    expect(config.framework).toBe("nitro");
    expect(config.buildCommand).toBe("pnpm build");
    expect(config.crons).toEqual([
      {
        path: "/api/internal/heartbeat",
        schedule: "* * * * *",
      },
    ]);
  });

  it("omits buildCommand when set to null", () => {
    const config = juniorVercelConfig({ buildCommand: null });

    expect(config.buildCommand).toBeUndefined();
  });
});
