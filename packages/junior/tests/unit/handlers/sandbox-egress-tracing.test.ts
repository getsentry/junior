import { afterEach, describe, expect, it } from "vitest";
import {
  getSandboxEgressTracePropagationDomains,
  setSandboxEgressTracePropagationDomains,
  shouldPropagateSandboxEgressTrace,
} from "@/chat/sandbox/egress-tracing";

describe("sandbox egress tracing config", () => {
  afterEach(() => {
    setSandboxEgressTracePropagationDomains(undefined);
  });

  it("matches exact domains case-insensitively", () => {
    setSandboxEgressTracePropagationDomains(["SENTRY.IO"]);

    expect(getSandboxEgressTracePropagationDomains()).toEqual(["sentry.io"]);
    expect(shouldPropagateSandboxEgressTrace("sentry.io")).toBe(true);
    expect(shouldPropagateSandboxEgressTrace("SENTRY.IO")).toBe(true);
    expect(shouldPropagateSandboxEgressTrace("us.sentry.io")).toBe(false);
  });

  it("matches leading wildcard subdomains without matching the apex", () => {
    setSandboxEgressTracePropagationDomains(["*.sentry.io"]);

    expect(shouldPropagateSandboxEgressTrace("us.sentry.io")).toBe(true);
    expect(shouldPropagateSandboxEgressTrace("api.us.sentry.io")).toBe(true);
    expect(shouldPropagateSandboxEgressTrace("sentry.io")).toBe(false);
  });

  it("rejects non-leading wildcard patterns", () => {
    expect(() =>
      setSandboxEgressTracePropagationDomains(["api.*.sentry.io"]),
    ).toThrow(
      "sandbox.egressTracePropagationDomains entries must be exact domains or leading wildcard domains",
    );
  });
});
