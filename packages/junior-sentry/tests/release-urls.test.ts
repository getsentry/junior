import { describe, expect, it } from "vitest";
import { parseSentryReleaseLink } from "../src/links/release-urls.js";

const parse = (url: string) => parseSentryReleaseLink(new URL(url));

describe("Sentry release URLs", () => {
  it("reads a release from each page and tab in both org URL forms", () => {
    for (const url of [
      "https://sentry.io/organizations/acme/releases/junior%404.2.0/",
      "https://sentry.io/organizations/acme/explore/releases/junior%404.2.0/commits/",
      "https://acme.sentry.io/releases/junior%404.2.0/files-changed/",
      "https://acme.sentry.io/explore/releases/junior@4.2.0/builds/",
    ]) {
      expect(parse(url)).toEqual({ org: "acme", version: "junior@4.2.0" });
    }
  });

  it("keeps the one project that the page is filtered to", () => {
    expect(
      parse("https://acme.sentry.io/releases/4.2.0%2Babc/?project=11"),
    ).toEqual({ org: "acme", version: "4.2.0+abc", project: "11" });
    expect(
      parse("https://acme.sentry.io/releases/4.2.0/?project=11&project=12"),
    ).toEqual({ org: "acme", version: "4.2.0" });
  });

  it("ignores other pages", () => {
    for (const url of [
      "https://acme.sentry.io/releases/",
      "https://acme.sentry.io/releases/new-events/",
      "https://acme.sentry.io/releases/4.2.0/settings/",
      "https://acme.sentry.io/releases/%E0%A4%A/",
      "https://acme.sentry.io/explore/traces/4.2.0/",
    ]) {
      expect(parse(url)).toBeUndefined();
    }
  });
});
