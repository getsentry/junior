import { afterEach, describe, expect, it } from "vitest";
import {
  getCapabilityProvider,
  isKnownCapability,
  listCapabilityProviders,
} from "@/chat/capabilities/catalog";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";

function configureCatalog(manifests: PluginManifest[]): void {
  setPluginCatalogConfig({
    inlineManifests: manifests.map((manifest) => ({ manifest })),
  });
}

afterEach(() => {
  setPluginCatalogConfig(undefined);
});

describe("capability catalog", () => {
  it("refreshes cached providers when the plugin catalog signature changes", () => {
    configureCatalog([
      {
        name: "demo",
        description: "Demo plugin",
        capabilities: ["demo.read"],
        configKeys: ["demo.token"],
      },
    ]);

    expect(getCapabilityProvider("demo.read")).toMatchObject({
      provider: "demo",
    });

    configureCatalog([
      {
        name: "other",
        description: "Other plugin",
        capabilities: ["other.read"],
        configKeys: ["other.token"],
      },
    ]);

    expect(getCapabilityProvider("demo.read")).toBeUndefined();
    expect(isKnownCapability("other.read")).toBe(true);
  });

  it("returns defensive copies from provider accessors", () => {
    configureCatalog([
      {
        name: "demo",
        description: "Demo plugin",
        capabilities: ["demo.read"],
        configKeys: ["demo.token", "demo.repo"],
        target: {
          type: "repo",
          configKey: "repo",
          commandFlags: ["--repo", "-R"],
        },
      },
    ]);

    const listed = listCapabilityProviders();
    const direct = getCapabilityProvider("demo.read");

    expect(direct).toBeDefined();
    if (!direct) {
      throw new Error("Expected demo.read provider");
    }

    listed[0]!.provider = "mutated";
    listed[0]!.capabilities.push("demo.write");
    listed[0]!.configKeys.push("demo.extra");
    listed[0]!.target!.configKey = "mutated.repo";
    listed[0]!.target!.commandFlags!.push("--mutated");
    direct.provider = "direct-mutation";
    direct.capabilities.push("direct.write");
    direct.configKeys.push("direct.extra");
    direct.target!.configKey = "direct.repo";
    direct.target!.commandFlags!.push("--direct");

    expect(listCapabilityProviders()).toEqual([
      {
        provider: "demo",
        capabilities: ["demo.read"],
        configKeys: ["demo.token", "demo.repo"],
        target: {
          type: "repo",
          configKey: "demo.repo",
          commandFlags: ["--repo", "-R"],
        },
      },
    ]);
    expect(getCapabilityProvider("demo.read")).toEqual({
      provider: "demo",
      capabilities: ["demo.read"],
      configKeys: ["demo.token", "demo.repo"],
      target: {
        type: "repo",
        configKey: "demo.repo",
        commandFlags: ["--repo", "-R"],
      },
    });
  });
});
