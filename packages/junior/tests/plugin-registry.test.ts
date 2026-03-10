import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/home");
  vi.doUnmock("@/chat/plugins/package-discovery");
});

describe("plugin registry", () => {
  it("is empty when no local or installed plugin packages are present", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-empty-"),
    );
    process.chdir(tempRoot);

    vi.doMock("@/chat/home", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: [],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
    }));

    const registry = await import("@/chat/plugins/registry");

    expect(registry.getPluginProviders()).toEqual([]);
    expect(registry.getPluginCapabilityProviders()).toEqual([]);
    expect(registry.getPluginSkillRoots()).toEqual([]);
    expect(registry.getPluginOAuthConfig("unknown")).toBeUndefined();
    expect(registry.isPluginProvider("sentry")).toBe(false);
    expect(registry.isPluginCapability("sentry.api")).toBe(false);
    expect(registry.isPluginConfigKey("sentry.org")).toBe(false);
    expect(() =>
      registry.createPluginBroker("sentry", {
        userTokenStore: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
        },
      }),
    ).toThrow('Unknown plugin provider: "sentry"');
  });
});
