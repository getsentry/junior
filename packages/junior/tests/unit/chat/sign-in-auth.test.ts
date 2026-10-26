import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAllowedDomains } from "@/chat/sign-in/allowlist";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("allowed domains", () => {
  it("reads the dashboard env list as a JSON array or comma separated values", () => {
    vi.stubEnv(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
      '["Sentry.io", "example.com"]',
    );
    expect(resolveAllowedDomains()).toEqual(["sentry.io", "example.com"]);

    vi.stubEnv("JUNIOR_DASHBOARD_GOOGLE_DOMAINS", "sentry.io, example.com");
    expect(resolveAllowedDomains()).toEqual(["sentry.io", "example.com"]);
  });

  it("rejects an env list that is not a JSON string array", () => {
    vi.stubEnv("JUNIOR_DASHBOARD_GOOGLE_DOMAINS", "[1]");

    expect(() => resolveAllowedDomains()).toThrow(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS must be a JSON string array",
    );
  });
});
