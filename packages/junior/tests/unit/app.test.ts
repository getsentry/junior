import { describe, expect, it } from "vitest";
import { createApp } from "@/app";

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
});
