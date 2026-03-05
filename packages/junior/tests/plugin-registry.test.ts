import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/chat/home", () => ({
  pluginRoots: () => [path.resolve(process.cwd(), "plugins")]
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
  it("discovers sentry plugin from manifest", () => {
    const providers = getPluginProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2);
    const sentry = providers.find((p) => p.manifest.name === "sentry");
    expect(sentry).toBeDefined();
    expect(sentry!.manifest.capabilities).toEqual([
      "sentry.api"
    ]);
    expect(sentry!.manifest.configKeys).toEqual(["sentry.org", "sentry.project"]);
    expect(sentry!.manifest.credentials).toMatchObject({
      authTokenPlaceholder: "host_managed_credential"
    });
  });

  it("discovers github plugin from manifest", () => {
    const providers = getPluginProviders();
    const github = providers.find((p) => p.manifest.name === "github");
    expect(github).toBeDefined();
    expect(github!.manifest.capabilities).toEqual([
      "github.issues.read",
      "github.issues.write",
      "github.issues.comment",
      "github.labels.write"
    ]);
    expect(github!.manifest.configKeys).toEqual(["github.repo"]);
    expect(github!.manifest.credentials.type).toBe("github-app");
    expect(github!.manifest.credentials).toMatchObject({
      authTokenPlaceholder: "ghp_host_managed_credential"
    });
  });

  it("registers plugin capabilities", () => {
    expect(isPluginCapability("sentry.api")).toBe(true);
    expect(isPluginCapability("sentry.issues.read")).toBe(false);
    expect(isPluginCapability("github.issues.read")).toBe(true);
  });

  it("registers plugin config keys", () => {
    expect(isPluginConfigKey("sentry.org")).toBe(true);
    expect(isPluginConfigKey("sentry.project")).toBe(true);
    expect(isPluginConfigKey("github.repo")).toBe(true);
  });

  it("identifies plugin providers", () => {
    expect(isPluginProvider("sentry")).toBe(true);
    expect(isPluginProvider("github")).toBe(true);
    expect(isPluginProvider("unknown")).toBe(false);
  });

  it("returns capability provider definitions for catalog merge", () => {
    const capProviders = getPluginCapabilityProviders();
    const sentry = capProviders.find((p) => p.provider === "sentry");
    expect(sentry).toBeDefined();
    expect(sentry!.capabilities).toContain("sentry.api");
    expect(sentry!.configKeys).toContain("sentry.org");

    const github = capProviders.find((p) => p.provider === "github");
    expect(github).toBeDefined();
    expect(github!.capabilities).toContain("github.issues.read");
    expect(github!.configKeys).toContain("github.repo");
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

  it("returns undefined OAuth config for providers without OAuth", () => {
    expect(getPluginOAuthConfig("github")).toBeUndefined();
    expect(getPluginOAuthConfig("unknown")).toBeUndefined();
  });

  it("includes plugin skill roots", () => {
    const roots = getPluginSkillRoots();
    expect(roots.some((r) => r.includes("plugins/sentry/skills"))).toBe(true);
    expect(roots.some((r) => r.includes("plugins/github/skills"))).toBe(true);
  });

  it("creates a credential broker from sentry plugin manifest", () => {
    const mockTokenStore = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {}
    };
    const broker = createPluginBroker("sentry", { userTokenStore: mockTokenStore });
    expect(broker).toBeDefined();
    expect(typeof broker.issue).toBe("function");
  });

  it("creates a credential broker from github plugin manifest", () => {
    const mockTokenStore = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {}
    };
    const broker = createPluginBroker("github", { userTokenStore: mockTokenStore });
    expect(broker).toBeDefined();
    expect(typeof broker.issue).toBe("function");
  });
});
