import { afterEach, describe, expect, it } from "vitest";
import {
  getCapabilityProvider,
  isKnownCapability,
  listCapabilityProviders,
  type CapabilityProviderDefinition,
} from "@/chat/capabilities/catalog";

let currentSignature = "default";
let currentProviders: CapabilityProviderDefinition[] = [];

const catalogSource = {
  getPluginCatalogSignature: () => currentSignature,
  getPluginCapabilityProviders: () =>
    currentProviders.map(cloneProviderDefinition),
};

function cloneProviderDefinition(
  provider: CapabilityProviderDefinition,
): CapabilityProviderDefinition {
  return {
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys],
    ...(provider.target
      ? {
          target: {
            ...provider.target,
            ...(provider.target.commandFlags
              ? { commandFlags: [...provider.target.commandFlags] }
              : {}),
          },
        }
      : {}),
  };
}

afterEach(() => {
  currentSignature = "default";
  currentProviders = [];
});

describe("capability catalog", () => {
  it("refreshes cached providers when the plugin catalog signature changes", () => {
    currentSignature = "refresh:before";
    currentProviders = [
      {
        provider: "demo",
        capabilities: ["demo.read"],
        configKeys: ["demo.token"],
      },
    ];

    expect(getCapabilityProvider("demo.read", catalogSource)).toMatchObject({
      provider: "demo",
    });

    currentSignature = "refresh:after";
    currentProviders = [
      {
        provider: "other",
        capabilities: ["other.read"],
        configKeys: ["other.token"],
      },
    ];

    expect(getCapabilityProvider("demo.read", catalogSource)).toBeUndefined();
    expect(isKnownCapability("other.read", catalogSource)).toBe(true);
  });

  it("returns defensive copies from provider accessors", () => {
    currentSignature = "defensive-copies";
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

    const listed = listCapabilityProviders(catalogSource);
    const direct = getCapabilityProvider("demo.read", catalogSource);

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

    expect(listCapabilityProviders(catalogSource)).toEqual([
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
    expect(getCapabilityProvider("demo.read", catalogSource)).toEqual({
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

  it("does not share cache entries between injected sources", () => {
    const firstSource = {
      getPluginCatalogSignature: () => "shared-signature",
      getPluginCapabilityProviders: () => [
        {
          provider: "first",
          capabilities: ["first.read"],
          configKeys: ["first.token"],
        },
      ],
    };
    const secondSource = {
      getPluginCatalogSignature: () => "shared-signature",
      getPluginCapabilityProviders: () => [
        {
          provider: "second",
          capabilities: ["second.read"],
          configKeys: ["second.token"],
        },
      ],
    };

    expect(getCapabilityProvider("first.read", firstSource)).toMatchObject({
      provider: "first",
    });
    expect(getCapabilityProvider("first.read", secondSource)).toBeUndefined();
    expect(getCapabilityProvider("second.read", secondSource)).toMatchObject({
      provider: "second",
    });
  });
});
