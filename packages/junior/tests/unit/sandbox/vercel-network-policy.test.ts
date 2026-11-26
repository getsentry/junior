import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toVercelNetworkPolicy } from "@/chat/sandbox/egress/vercel";
import { useConfig } from "../../fixtures/config";

const FORWARD_URL =
  "https://junior.example.com/api/internal/sandbox-egress/signed-token";

describe("toVercelNetworkPolicy", () => {
  beforeEach(() => {
    useConfig({
      deployment: { configuredBaseUrl: "https://junior.example.com" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards credentialed domains and transforms trace domains", () => {
    expect(
      toVercelNetworkPolicy({
        credentialEgress: {
          credentialToken: "signed-token",
          domains: ["us.sentry.io", "sentry.io"],
        },
        traceHeaders: {
          domains: ["*.example.com"],
          headers: { "sentry-trace": "trace-span-1" },
        },
      }),
    ).toEqual({
      allow: {
        "*": [],
        "*.example.com": [
          { transform: [{ headers: { "sentry-trace": "trace-span-1" } }] },
        ],
        "sentry.io": [{ forwardURL: FORWARD_URL }],
        "us.sentry.io": [{ forwardURL: FORWARD_URL }],
      },
    });
  });

  it("keeps every other domain open", () => {
    expect(toVercelNetworkPolicy("allow-all")).toBe("allow-all");
    expect(toVercelNetworkPolicy({})).toEqual({ allow: { "*": [] } });
  });

  it("fails without a public callback URL for credentialed domains", () => {
    vi.stubEnv("JUNIOR_BASE_URL", undefined);
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", undefined);
    vi.stubEnv("VERCEL_URL", undefined);
    useConfig();

    expect(() =>
      toVercelNetworkPolicy({
        credentialEgress: {
          credentialToken: "signed-token",
          domains: ["sentry.io"],
        },
      }),
    ).toThrow("Cannot determine base URL for sandbox credential egress");
  });
});
