import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSignInAllowlist } from "@/chat/sign-in";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sign-in allowlist", () => {
  it("reads dashboard env lists as JSON arrays or comma separated values", () => {
    vi.stubEnv(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
      '["Sentry.io", "example.com"]',
    );
    vi.stubEnv(
      "JUNIOR_DASHBOARD_ALLOWED_EMAILS",
      "a@example.net, b@example.net",
    );

    expect(resolveSignInAllowlist()).toEqual({
      domains: ["sentry.io", "example.com"],
      emails: ["a@example.net", "b@example.net"],
    });
  });

  it("rejects an env list that is not a JSON string array", () => {
    vi.stubEnv("JUNIOR_DASHBOARD_GOOGLE_DOMAINS", "[1]");

    expect(() => resolveSignInAllowlist()).toThrow(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS must be a JSON string array",
    );
  });
});
