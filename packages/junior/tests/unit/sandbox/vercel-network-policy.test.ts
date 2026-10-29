import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toVercelNetworkPolicy } from "@/chat/sandbox/egress/vercel";

const FORWARD_URL =
  "https://junior.example.com/api/internal/sandbox-egress/signed-token";

describe("toVercelNetworkPolicy", () => {
  beforeEach(() => {
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
  });

  afterEach(() => {
    delete process.env.JUNIOR_BASE_URL;
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
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;

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
