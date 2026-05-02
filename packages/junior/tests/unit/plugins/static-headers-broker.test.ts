import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaticHeadersBroker } from "@/chat/plugins/auth/static-headers-broker";
import type {
  PluginManifest,
  StaticHeadersCredentials,
} from "@/chat/plugins/types";

const ORIGINAL_ENV = { ...process.env };

const MANIFEST: PluginManifest = {
  name: "example",
  description: "Example API access",
  capabilities: ["example.query"],
  configKeys: [],
  credentials: {
    type: "static-headers",
    apiDomains: ["api.example.com"],
    apiHeaders: {
      Authorization: "$EXAMPLE_AUTH_HEADER",
      "Content-Type": "text/plain",
    },
  },
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("static headers credential broker", () => {
  it("resolves env-backed header values into header transforms", async () => {
    process.env.EXAMPLE_AUTH_HEADER = "Basic abc123";

    const broker = createStaticHeadersBroker(
      MANIFEST,
      MANIFEST.credentials as StaticHeadersCredentials,
    );
    const lease = await broker.issue({ reason: "test:static-headers" });

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

  it("throws when an env-backed header references a missing env var", async () => {
    delete process.env.EXAMPLE_AUTH_HEADER;

    const broker = createStaticHeadersBroker(
      MANIFEST,
      MANIFEST.credentials as StaticHeadersCredentials,
    );

    await expect(
      broker.issue({ reason: "test:missing-static-header-env" }),
    ).rejects.toThrow(
      'Missing EXAMPLE_AUTH_HEADER for static headers credential provider "example"',
    );
  });
});
