import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHeadersBroker } from "@/chat/plugins/auth/api-headers-broker";
import type { PluginManifest } from "@/chat/plugins/types";

const ORIGINAL_ENV = { ...process.env };
const SYSTEM_CREDENTIAL_CONTEXT = {
  actor: { platform: "system" as const, name: "scheduler" },
};

const MANIFEST: PluginManifest = {
  name: "example",
  displayName: "Example",
  description: "Example API access",
  capabilities: ["example.query"],
  configKeys: [],
  domains: ["api.example.com"],
  apiHeaders: {
    Authorization: "${EXAMPLE_AUTH_HEADER}",
    "Content-Type": "text/plain",
  },
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("API headers broker", () => {
  it("resolves env-backed header values into header transforms", async () => {
    process.env.EXAMPLE_AUTH_HEADER = "Basic abc123";

    const broker = createApiHeadersBroker(MANIFEST);
    const lease = await broker.issue({
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:api-headers",
    });

    expect(lease.provider).toBe("example");
    expect(lease.env).toEqual({});
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.example.com",
        headers: {
          Authorization: "Basic abc123",
          "Content-Type": "text/plain",
        },
      },
    ]);
  });

  it("includes plugin command env in issued leases", async () => {
    process.env.EXAMPLE_AUTH_HEADER = "Basic abc123";

    const broker = createApiHeadersBroker({
      ...MANIFEST,
      commandEnv: {
        EXAMPLE_API_KEY: "host_managed_credential",
      },
    });
    const lease = await broker.issue({
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:command-env",
    });

    expect(lease.env).toEqual({
      EXAMPLE_API_KEY: "host_managed_credential",
    });
  });

  it("throws when an env-backed header references a missing env var", async () => {
    delete process.env.EXAMPLE_AUTH_HEADER;

    const broker = createApiHeadersBroker(MANIFEST);

    await expect(
      broker.issue({
        context: SYSTEM_CREDENTIAL_CONTEXT,
        reason: "test:missing-api-header-env",
      }),
    ).rejects.toThrow(
      'Missing EXAMPLE_AUTH_HEADER for API header provider "example"',
    );
  });
});
