import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityProviderDefinition } from "@/chat/capabilities/catalog";

let currentSignature = "sig-1";
let currentProviders: CapabilityProviderDefinition[] = [];

function cloneProviderDefinition(
  provider: CapabilityProviderDefinition,
): CapabilityProviderDefinition {
  return {
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys],
    ...(provider.target ? { target: { ...provider.target } } : {}),
  };
}

async function loadCatalogModule() {
  vi.resetModules();
  vi.doMock("@/chat/logging", () => ({
    logInfo: () => undefined,
  }));
  vi.doMock("@/chat/plugins/registry", () => ({
    getPluginCatalogSignature: () => currentSignature,
    getPluginCapabilityProviders: () =>
      currentProviders.map(cloneProviderDefinition),
  }));
  return await import("@/chat/capabilities/catalog");
}

afterEach(() => {
  currentSignature = "sig-1";
  currentProviders = [];
  vi.resetModules();
  vi.doUnmock("@/chat/logging");
  vi.doUnmock("@/chat/plugins/registry");
});

describe("capability catalog", () => {
  it("refreshes cached providers when the plugin catalog signature changes", async () => {
    currentProviders = [
      {
        provider: "demo",
        capabilities: ["demo.read"],
        configKeys: ["demo.token"],
      },
    ];

    const catalog = await loadCatalogModule();

    expect(catalog.getCapabilityProvider("demo.read")).toMatchObject({
      provider: "demo",
    });

    currentSignature = "sig-2";
    currentProviders = [
      {
        provider: "other",
        capabilities: ["other.read"],
        configKeys: ["other.token"],
      },
    ];

    expect(catalog.getCapabilityProvider("demo.read")).toBeUndefined();
    expect(catalog.isKnownCapability("other.read")).toBe(true);
  });

  it("returns defensive copies from provider accessors", async () => {
    currentProviders = [
      {
        provider: "demo",
        capabilities: ["demo.read"],
        configKeys: ["demo.token"],
        target: {
          type: "repo",
          configKey: "demo.repo",
          commandFlags: ["--repo", "-R"],
        },
      },
    ];

    const catalog = await loadCatalogModule();
    const listed = catalog.listCapabilityProviders();
    const direct = catalog.getCapabilityProvider("demo.read");

    expect(direct).toBeDefined();

    listed[0]!.provider = "mutated";
    listed[0]!.capabilities.push("demo.write");
    listed[0]!.configKeys.push("demo.extra");
    listed[0]!.target!.configKey = "mutated.repo";
    listed[0]!.target!.commandFlags!.push("--mutated");
    direct!.provider = "direct-mutation";
    direct!.capabilities.push("direct.write");
    direct!.configKeys.push("direct.extra");
    direct!.target!.configKey = "direct.repo";
    direct!.target!.commandFlags!.push("--direct");

    expect(catalog.listCapabilityProviders()).toEqual([
      {
        provider: "demo",
        capabilities: ["demo.read"],
        configKeys: ["demo.token"],
        target: {
          type: "repo",
          configKey: "demo.repo",
          commandFlags: ["--repo", "-R"],
        },
      },
    ]);
    expect(catalog.getCapabilityProvider("demo.read")).toEqual({
      provider: "demo",
      capabilities: ["demo.read"],
      configKeys: ["demo.token"],
      target: {
        type: "repo",
        configKey: "demo.repo",
        commandFlags: ["--repo", "-R"],
      },
    });
  });
});
