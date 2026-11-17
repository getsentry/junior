import { describe, expect, it } from "vitest";
import { isAllowedDomain, parseEmail } from "@/chat/identities/trust";

describe("parseEmail", () => {
  it("returns the normalized email and its domain", () => {
    expect(parseEmail(" Person@SENTRY.io ")).toEqual({
      email: "person@sentry.io",
      domain: "sentry.io",
    });
  });

  it("rejects values that are not a valid email", () => {
    for (const value of ["@sentry.io", "sentry.io", "", undefined]) {
      expect(parseEmail(value)).toBeUndefined();
    }
  });
});

describe("isAllowedDomain", () => {
  const allowedDomains = ["sentry.io"];

  it("compares only domains", () => {
    const options = { allowedDomains, ifNoDomains: "deny" } as const;
    expect(isAllowedDomain("SENTRY.io", options)).toBe(true);
    expect(isAllowedDomain("person@sentry.io", options)).toBe(false);
    expect(isAllowedDomain(undefined, options)).toBe(false);
  });

  it("applies the named option to an empty list", () => {
    expect(
      isAllowedDomain(undefined, { allowedDomains: [], ifNoDomains: "allow" }),
    ).toBe(true);
    expect(
      isAllowedDomain("sentry.io", { allowedDomains: [], ifNoDomains: "deny" }),
    ).toBe(false);
  });
});
