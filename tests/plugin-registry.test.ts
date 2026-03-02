import { describe, expect, it } from "vitest";
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
  it("discovers sentry plugin from manifest", () => {
    const providers = getPluginProviders();
    expect(providers.length).toBeGreaterThanOrEqual(1);
    const sentry = providers.find((p) => p.manifest.name === "sentry");
    expect(sentry).toBeDefined();
    expect(sentry!.manifest.capabilities).toEqual([
      "sentry.api"
    ]);
    expect(sentry!.manifest.configKeys).toEqual(["sentry.org", "sentry.project"]);
  });

  it("registers plugin capabilities", () => {
    expect(isPluginCapability("sentry.api")).toBe(true);
    expect(isPluginCapability("sentry.issues.read")).toBe(false);
    expect(isPluginCapability("github.issues.read")).toBe(false);
  });

  it("registers plugin config keys", () => {
    expect(isPluginConfigKey("sentry.org")).toBe(true);
    expect(isPluginConfigKey("sentry.project")).toBe(true);
    expect(isPluginConfigKey("github.repo")).toBe(false);
  });

  it("identifies plugin providers", () => {
    expect(isPluginProvider("sentry")).toBe(true);
    expect(isPluginProvider("github")).toBe(false);
    expect(isPluginProvider("unknown")).toBe(false);
  });

  it("returns capability provider definitions for catalog merge", () => {
    const capProviders = getPluginCapabilityProviders();
    const sentry = capProviders.find((p) => p.provider === "sentry");
    expect(sentry).toBeDefined();
    expect(sentry!.capabilities).toContain("sentry.api");
    expect(sentry!.configKeys).toContain("sentry.org");
  });

  it("returns OAuth config for plugin providers", () => {
    const config = getPluginOAuthConfig("sentry");
    expect(config).toBeDefined();
    expect(config!.clientIdEnv).toBe("SENTRY_CLIENT_ID");
    expect(config!.clientSecretEnv).toBe("SENTRY_CLIENT_SECRET");
    expect(config!.authorizeEndpoint).toBe("https://sentry.io/oauth/authorize/");
    expect(config!.tokenEndpoint).toBe("https://sentry.io/oauth/token/");
    expect(config!.scope).toBe("event:read org:read project:read");
    expect(config!.callbackPath).toBe("/api/oauth/callback/sentry");
  });

  it("returns undefined OAuth config for non-plugin providers", () => {
    expect(getPluginOAuthConfig("github")).toBeUndefined();
    expect(getPluginOAuthConfig("unknown")).toBeUndefined();
  });

  it("includes plugin skill roots", () => {
    const roots = getPluginSkillRoots();
    expect(roots.some((r) => r.includes("plugins/sentry/skills"))).toBe(true);
  });

  it("creates a credential broker from plugin manifest", () => {
    const mockTokenStore = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {}
    };
    const broker = createPluginBroker("sentry", { userTokenStore: mockTokenStore });
    expect(broker).toBeDefined();
    expect(typeof broker.issue).toBe("function");
  });
});
