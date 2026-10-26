import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAllowedDomains } from "@/chat/sign-in/allowlist";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("allowed domains", () => {
  it("reads JUNIOR_ALLOWED_DOMAINS as a JSON array or comma separated values", () => {
    vi.stubEnv("JUNIOR_ALLOWED_DOMAINS", '["Sentry.io", "example.com"]');
    expect(resolveAllowedDomains()).toEqual(["sentry.io", "example.com"]);

    vi.stubEnv("JUNIOR_ALLOWED_DOMAINS", " sentry.io, example.com,SENTRY.io ");
    expect(resolveAllowedDomains()).toEqual(["sentry.io", "example.com"]);
  });

  it("prefers the createApp option over the env list", () => {
    vi.stubEnv("JUNIOR_ALLOWED_DOMAINS", "example.com");
    expect(resolveAllowedDomains(["Sentry.io"])).toEqual(["sentry.io"]);
  });

  it("rejects an env list that is not a JSON string array", () => {
    vi.stubEnv("JUNIOR_ALLOWED_DOMAINS", "[1]");

    expect(() => resolveAllowedDomains()).toThrow(
      "JUNIOR_ALLOWED_DOMAINS must be a JSON string array",
    );
  });
});
