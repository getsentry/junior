import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import {
  getSandboxResources,
  setSandboxResourceConfig,
} from "@/chat/sandbox/resources";

afterEach(() => {
  setSandboxResourceConfig(undefined);
});

describe("createApp sandbox config", () => {
  it("configures sandbox vCPUs", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
      sandbox: { vcpus: 4 },
    });

    expect(getSandboxResources()).toEqual({ vcpus: 4 });
  });

  it("rejects invalid sandbox vCPUs", async () => {
    await expect(
      createApp({
        plugins: defineJuniorPlugins([]),
        sandbox: { vcpus: 0 },
      }),
    ).rejects.toThrow("sandbox.vcpus must be a positive integer");
  });
});
