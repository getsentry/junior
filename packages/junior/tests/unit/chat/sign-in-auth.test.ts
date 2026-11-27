import { describe, expect, it } from "vitest";
import { getChatConfig } from "@/chat/config";
import { useConfig } from "../../fixtures/config";

describe("allowed domains", () => {
  it("reads JUNIOR_ALLOWED_DOMAINS as a JSON array or comma separated values", () => {
    useConfig({ signIn: { allowedDomains: '["Sentry.io", "example.com"]' } });
    expect(getChatConfig().trust.allowedDomains).toEqual([
      "sentry.io",
      "example.com",
    ]);

    useConfig({
      signIn: { allowedDomains: " sentry.io, example.com,SENTRY.io " },
    });
    expect(getChatConfig().trust.allowedDomains).toEqual([
      "sentry.io",
      "example.com",
    ]);
  });

  it("prefers the createApp option over the env list", () => {
    useConfig({
      signIn: { allowedDomains: "example.com" },
      trust: { allowedDomains: ["Sentry.io"] },
    });
    expect(getChatConfig().trust.allowedDomains).toEqual(["sentry.io"]);
  });

  it("does not parse the env list when the createApp option is set", () => {
    useConfig({
      signIn: { allowedDomains: "[1]" },
      trust: { allowedDomains: ["Sentry.io"] },
    });
    expect(getChatConfig().trust.allowedDomains).toEqual(["sentry.io"]);
  });

  it("rejects an env list that is not a JSON string array", () => {
    expect(() => useConfig({ signIn: { allowedDomains: "[1]" } })).toThrow(
      "JUNIOR_ALLOWED_DOMAINS must be a JSON string array",
    );
  });
});
