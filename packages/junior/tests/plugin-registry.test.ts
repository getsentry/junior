import { describe, expect, it, vi } from "vitest";

vi.mock("@/chat/home", () => ({
  pluginRoots: () => []
}));
import {
  createPluginBroker,
  getPluginCapabilityProviders,
  getPluginOAuthConfig,
  getPluginProviders,
  getPluginSkillRoots,
  isPluginCapability,
  isPluginConfigKey,
  isPluginProvider
} from "@/chat/plugins/registry";

describe("plugin registry", () => {
  it("is empty when no local or installed plugin packages are present", () => {
    expect(getPluginProviders()).toEqual([]);
    expect(getPluginCapabilityProviders()).toEqual([]);
    expect(getPluginSkillRoots()).toEqual([]);
    expect(getPluginOAuthConfig("unknown")).toBeUndefined();
    expect(isPluginProvider("sentry")).toBe(false);
    expect(isPluginCapability("sentry.api")).toBe(false);
    expect(isPluginConfigKey("sentry.org")).toBe(false);
    expect(() =>
      createPluginBroker("sentry", {
        userTokenStore: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {}
        }
      })
    ).toThrow('Unknown plugin provider: "sentry"');
  });
});
