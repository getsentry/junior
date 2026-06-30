import {
  normalizeSandboxEgressTracePropagationDomains,
  shouldPropagateSandboxEgressTrace,
} from "@/chat/sandbox/egress/tracing";
import { describe, expect, it } from "vitest";

describe("sandbox egress tracing config", () => {
  it("matches exact domains case-insensitively", () => {
    const domains = normalizeSandboxEgressTracePropagationDomains([
      "SENTRY.IO",
    ]);

    expect(domains).toEqual(["sentry.io"]);
    expect(shouldPropagateSandboxEgressTrace("sentry.io", { domains })).toBe(
      true,
    );
    expect(shouldPropagateSandboxEgressTrace("SENTRY.IO", { domains })).toBe(
      true,
    );
    expect(shouldPropagateSandboxEgressTrace("us.sentry.io", { domains })).toBe(
      false,
    );
  });

  it("matches leading wildcard subdomains without matching the apex", () => {
    const domains = normalizeSandboxEgressTracePropagationDomains([
      "*.sentry.io",
    ]);

    expect(shouldPropagateSandboxEgressTrace("us.sentry.io", { domains })).toBe(
      true,
    );
    expect(
      shouldPropagateSandboxEgressTrace("api.us.sentry.io", { domains }),
    ).toBe(true);
    expect(shouldPropagateSandboxEgressTrace("sentry.io", { domains })).toBe(
      false,
    );
  });

  it("rejects non-leading wildcard patterns", () => {
    expect(() =>
      normalizeSandboxEgressTracePropagationDomains(["api.*.sentry.io"]),
    ).toThrow(
      "sandbox.egressTracePropagationDomains entries must be exact domains or leading wildcard domains",
    );
  });
});
