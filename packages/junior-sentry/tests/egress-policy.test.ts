import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import type { EgressHookContext } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentryPlugin } from "../src";

const ORIGINAL_ENV = { ...process.env };

function grantFor(
  method: string,
  url: string,
  options: { withoutCredential?: true } = {},
) {
  return sentryPlugin().hooks?.grantForEgress?.({
    request: { method, url, ...options },
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
    "https://sentry.io/api/0/users/me/",
    "https://us.sentry.io/api/0/users/123",
  ])("denies DELETE %s", (url) => {
    expect(() => grantFor("DELETE", url)).toThrow(EgressPolicyDenied);
    expect(() => grantFor("delete", url)).toThrow(EgressPolicyDenied);
  });

  it("denies protected deletes for a request that carries its own credential", () => {
    expect(() =>
      grantFor("DELETE", "https://sentry.io/api/0/projects/sentry/junior/", {
        withoutCredential: true,
      }),
    ).toThrow(EgressPolicyDenied);
  });

  it("sandbox-credentials#unknown-write-denied: sends known writes with user OAuth and denies other writes", () => {
    for (const [method, url] of [
      ["GET", "https://sentry.io/api/0/organizations/sentry/"],
      ["PUT", "https://sentry.io/api/0/projects/sentry/junior/"],
      ["POST", "https://sentry.io/api/0/teams/sentry/eng/projects/"],
      ["POST", "https://sentry.io/api/0/projects/sentry/junior/teams/eng/"],
      ["DELETE", "https://sentry.io/api/0/projects/sentry/junior/teams/eng/"],
      ["POST", "https://us.sentry.io/api/0/organizations/sentry/alert-rules/"],
      [
        "POST",
        "https://us.sentry.io/api/0/organizations/sentry/projects/junior/detectors/",
      ],
      ["PUT", "https://sentry.io/api/0/organizations/sentry/detectors/12/"],
      ["PUT", "https://sentry.io/api/0/organizations/sentry/issues/123/"],
      [
        "POST",
        "https://sentry.io/api/0/organizations/sentry/issues/123/notes/",
      ],
      ["POST", "https://sentry.io/api/0/issues/123/notes/"],
      ["POST", "https://sentry.io/api/0/groups/123/comments/"],
      ["PUT", "https://sentry.io/api/0/projects/sentry/junior/issues/?id=123"],
      [
        "POST",
        "https://sentry.io/api/0/organizations/sentry/issues/123/summarize/",
      ],
    ] as const) {
      expect(() => grantFor(method, url)).not.toThrow();
    }
    expect(
      grantFor("PUT", "https://sentry.io/api/0/projects/sentry/junior/"),
    ).toBeUndefined();

    for (const [method, url] of [
      ["DELETE", "https://sentry.io/api/0/projects/sentry/junior/keys/abc/"],
      ["DELETE", "https://sentry.io/api/0/organizations/sentry/issues/"],
      ["DELETE", "https://sentry.io/api/0/users/me/emails/"],
      ["POST", "https://sentry.io/api/0/organizations/sentry/org-auth-tokens/"],
      ["POST", "https://sentry.io/auth/login/sentry/"],
    ] as const) {
      expect(() => grantFor(method, url)).toThrow(
        "This Sentry write is blocked here because it would use the requester's account.",
      );
    }
  });

  it("sandbox-credentials#sentry-no-uploads: denies release, sourcemap, and debug file writes", () => {
    for (const url of [
      "https://sentry.io/api/0/organizations/sentry/releases/",
      "https://sentry.io/api/0/organizations/sentry/releases/1.0/deploys/",
      "https://sentry.io/api/0/projects/sentry/junior/releases/",
      "https://sentry.io/api/0/organizations/sentry/chunk-upload/",
      "https://sentry.io/api/0/organizations/sentry/artifactbundle/assemble/",
      "https://sentry.io/api/0/projects/sentry/junior/files/dsyms/",
      "https://sentry.io/api/0/projects/sentry/junior/files/difs/assemble/",
    ]) {
      expect(() => grantFor("POST", url)).toThrow(
        "Creating Sentry releases or uploading sourcemaps or debug files with the requester's account is blocked here.",
      );
    }
  });

  it("leaves writes that carry their own credential to that credential", () => {
    for (const url of [
      "https://sentry.io/api/0/organizations/sentry/releases/",
      "https://sentry.io/api/0/organizations/sentry/org-auth-tokens/",
    ]) {
      expect(() =>
        grantFor("POST", url, { withoutCredential: true }),
      ).not.toThrow();
    }
  });
});
