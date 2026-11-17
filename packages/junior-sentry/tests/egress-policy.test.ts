import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import type { EgressHookContext } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentryPlugin } from "../src";

const ORIGINAL_ENV = { ...process.env };

function grantFor(method: string, url: string) {
  return sentryPlugin().hooks?.grantForEgress?.({
    request: { method, url },
  } as EgressHookContext);
}

describe("sentry egress policy", () => {
  beforeEach(() => {
    process.env["SENTRY_READ_TOKEN"] = "org-read-token";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it.each([
    "https://sentry.io/api/0/organizations/sentry/",
    "https://us.sentry.io/api/0/organizations/sentry",
    "https://de.sentry.io/api/0/projects/sentry/junior/",
    "https://sentry.io/api/0//projects/sentry/junior",
    "https://sentry.io/api/0/projects/sentry/%6Aunior/",
  ])("denies DELETE %s", (url) => {
    expect(() => grantFor("DELETE", url)).toThrow(EgressPolicyDenied);
    expect(() => grantFor("delete", url)).toThrow(EgressPolicyDenied);
  });

  it("allows other requests to the same resources and other deletes", () => {
    expect(
      grantFor("GET", "https://sentry.io/api/0/organizations/sentry/"),
    ).toMatchObject({ name: "org-read" });
    expect(
      grantFor("PUT", "https://sentry.io/api/0/projects/sentry/junior/"),
    ).toBeUndefined();
    expect(
      grantFor(
        "DELETE",
        "https://sentry.io/api/0/projects/sentry/junior/keys/abc/",
      ),
    ).toBeUndefined();
    expect(
      grantFor(
        "DELETE",
        "https://sentry.io/api/0/organizations/sentry/issues/",
      ),
    ).toBeUndefined();
  });
});
