import { describe, expect, it } from "vitest";
import { resolveAllowedDomains } from "@/chat/sign-in/allowlist";
import { useConfig } from "../../fixtures/config";

describe("allowed domains", () => {
  it("reads JUNIOR_ALLOWED_DOMAINS as a JSON array or comma separated values", () => {
    useConfig({ signIn: { allowedDomains: '["Sentry.io", "example.com"]' } });
    expect(resolveAllowedDomains()).toEqual(["sentry.io", "example.com"]);

    useConfig({
      signIn: { allowedDomains: " sentry.io, example.com,SENTRY.io " },
    });
    expect(resolveAllowedDomains()).toEqual(["sentry.io", "example.com"]);
  });

  it("prefers the createApp option over the env list", () => {
    useConfig({ signIn: { allowedDomains: "example.com" } });
    expect(resolveAllowedDomains(["Sentry.io"])).toEqual(["sentry.io"]);
  });

  it("does not parse the env list when the createApp option is set", () => {
    useConfig({ signIn: { allowedDomains: "[1]" } });
    expect(resolveAllowedDomains(["Sentry.io"])).toEqual(["sentry.io"]);
  });

  it("rejects an env list that is not a JSON string array", () => {
    useConfig({ signIn: { allowedDomains: "[1]" } });

    expect(() => resolveAllowedDomains()).toThrow(
      "JUNIOR_ALLOWED_DOMAINS must be a JSON string array",
    );
  });
});
