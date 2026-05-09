import { afterEach, describe, expect, it } from "vitest";
import type { CredentialHeaderTransform } from "@/chat/credentials/broker";
import { TestCredentialBroker } from "@/chat/credentials/test-broker";

describe("test credential broker", () => {
  afterEach(() => {
    delete process.env.EVAL_TEST_CREDENTIAL_TOKEN;
  });

  it("preserves plugin-level header transforms separately from token domains", async () => {
    process.env.EVAL_TEST_CREDENTIAL_TOKEN = "test-token";
    const broker = new TestCredentialBroker({
      provider: "example",
      domains: ["api.example.com"],
      apiHeaders: {
        "X-Api-Version": "2026-01-01",
      },
      headerTransforms: (): CredentialHeaderTransform[] => [
        {
          domain: "uploads.example.com",
          headers: {
            "X-Upload-Mode": "sandbox",
          },
        },
        {
          domain: "api.example.com",
          headers: {
            Authorization: "PluginManaged value",
            "X-Shared": "plugin",
          },
        },
      ],
      env: {
        EXAMPLE_SITE: "example.com",
      },
      envKey: "EXAMPLE_TOKEN",
      placeholder: "host_managed_credential",
    });

    const lease = await broker.issue({ reason: "test:headers" });

    expect(lease.env).toEqual({
      EXAMPLE_SITE: "example.com",
      EXAMPLE_TOKEN: "host_managed_credential",
    });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "uploads.example.com",
        headers: {
          "X-Upload-Mode": "sandbox",
        },
      },
      {
        domain: "api.example.com",
        headers: {
          Authorization: "Bearer test-token",
          "X-Shared": "plugin",
          "X-Api-Version": "2026-01-01",
        },
      },
    ]);
  });

  it("issues header-only leases without token env", async () => {
    const broker = new TestCredentialBroker({
      provider: "example",
      headerTransforms: () => [
        {
          domain: "api.example.com",
          headers: {
            Authorization: "eval-test-example-api-header",
          },
        },
      ],
    });

    const lease = await broker.issue({ reason: "test:headers-only" });

    expect(lease.env).toEqual({});
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.example.com",
        headers: {
          Authorization: "eval-test-example-api-header",
        },
      },
    ]);
  });
});
