import { sentryPlugin } from "@sentry/junior-sentry";
import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import {
  issuePluginCredential,
  onPluginEgressResponse,
  selectPluginGrant,
} from "@/chat/plugins/credential-hooks";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";

let fixture: PluginAppFixture;

beforeEach(async () => {
  fixture = await createPluginAppFixture([]);
  const plugin = sentryPlugin({ auth: "service" });
  await createApp({
    plugins: defineJuniorPlugins([{ ...plugin, packageName: undefined }]),
    waitUntil: () => {},
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.cleanup();
});

describe("Sentry service connection", () => {
  it("issues read credentials without a user connection and denies writes", async () => {
    vi.stubEnv("SENTRY_SERVICE_TOKEN", "test-service-token");
    const grant = await selectPluginGrant({
      provider: "sentry",
      method: "GET",
      upstreamUrl: new URL(
        "https://us.sentry.io/api/0/organizations/example/events/",
      ),
    });
    expect(grant).toEqual({ name: "service-read", access: "read" });
    if (!grant) throw new Error("Expected a read grant");
    const tokenStore = new StateAdapterTokenStore(getStateAdapter());

    // Slack bots have an actor id but no user OAuth connection. Scheduled work
    // can instead have a system actor. Neither must borrow a user's token.
    for (const actor of [
      { type: "user" as const, userId: "UDEPLOYBOT" },
      { platform: "system" as const, name: "scheduler" },
    ]) {
      const result = await issuePluginCredential({
        actor,
        grant,
        provider: "sentry",
        userTokenStore: tokenStore,
      });
      expect(result.type).toBe("lease");
      if (result.type !== "lease") throw new Error("Expected a service lease");
      expect(result.lease.authorization).toBeUndefined();
      expect(result.lease.headerTransforms).toEqual(
        ["sentry.io", "us.sentry.io", "de.sentry.io"].map((domain) => ({
          domain,
          headers: { Authorization: "Bearer test-service-token" },
        })),
      );
    }

    for (const [method, url] of [
      ["PUT", "https://sentry.io/api/0/issues/123/"],
      ["GET", "https://sentry.io/account/settings/"],
      ["GET", "https://other.example/api/0/issues/123/"],
    ]) {
      await expect(
        selectPluginGrant({
          provider: "sentry",
          method,
          upstreamUrl: new URL(url),
        }),
      ).rejects.toBeInstanceOf(EgressPolicyDenied);
    }
  });

  it("reports missing or rejected service credentials without requesting user OAuth", async () => {
    vi.stubEnv("SENTRY_SERVICE_TOKEN", "");
    const result = await issuePluginCredential({
      actor: { type: "user", userId: "UDEPLOYBOT" },
      grant: { name: "service-read", access: "read" },
      provider: "sentry",
      userTokenStore: new StateAdapterTokenStore(getStateAdapter()),
    });
    expect(result).toEqual({
      type: "unavailable",
      message:
        "The Sentry service connection is not configured. An operator must set SENTRY_SERVICE_TOKEN on the host. User OAuth cannot repair this connection.",
    });
    const effects = await onPluginEgressResponse({
      provider: "sentry",
      grant: { name: "service-read", access: "read" },
      method: "GET",
      upstreamUrl: new URL("https://sentry.io/api/0/issues/123/"),
      response: {
        status: 401,
        headers: new Headers(),
        readText: async () => undefined,
      },
    });
    expect(effects.permissionDenied?.message).toContain(
      "Sentry rejected the service connection",
    );
  });
});
