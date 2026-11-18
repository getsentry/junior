import { describe, expect, it } from "vitest";
import { parseSentryAlertLink } from "../src/links/alert-urls.js";
import { parseSentryMonitorLink } from "../src/links/monitor-urls.js";

const parse = (url: string) => parseSentryMonitorLink(new URL(url));

describe("Sentry monitor URLs", () => {
  it("reads a monitor from each URL form", () => {
    expect(parse("https://sentry.io/organizations/acme/monitors/42/")).toEqual({
      org: "acme",
      detectorId: 42,
    });
    expect(parse("https://acme.sentry.io/monitors/42/")).toEqual({
      org: "acme",
      detectorId: 42,
    });
    expect(
      parse("https://acme.sentry.io/alerts/rules/uptime/web/42/details/"),
    ).toEqual({ org: "acme", detectorId: 42 });
    expect(
      parse(
        "https://sentry.io/organizations/acme/alerts/rules/crons/web/nightly-export/details/",
      ),
    ).toEqual({ org: "acme", cronSlug: "nightly-export" });
  });

  it("ignores other pages", () => {
    for (const url of [
      "https://acme.sentry.io/monitors/new/",
      "https://acme.sentry.io/monitors/crons/",
      "https://acme.sentry.io/monitors/42/edit/",
      "https://acme.sentry.io/monitors/12345678901234567890/",
      "https://acme.sentry.io/alerts/rules/details/42/",
      "https://acme.sentry.io/alerts/rules/uptime/web/new/details/",
      "https://acme.sentry.io/alerts/rules/crons/web/nightly-export/details/x/",
    ]) {
      expect(parse(url)).toBeUndefined();
    }
  });
});

describe("Sentry alert URLs", () => {
  const parseAlert = (url: string) => parseSentryAlertLink(new URL(url));

  it("reads an alert from each URL form", () => {
    for (const url of [
      "https://sentry.io/organizations/acme/monitors/alerts/6363564/",
      "https://acme.sentry.io/monitors/alerts/6363564/",
    ]) {
      expect(parseAlert(url)).toEqual({ org: "acme", workflowId: 6363564 });
    }
  });

  it("ignores other pages", () => {
    for (const url of [
      "https://acme.sentry.io/monitors/alerts/",
      "https://acme.sentry.io/monitors/alerts/new/",
      "https://acme.sentry.io/monitors/alerts/42/edit/",
      "https://acme.sentry.io/monitors/42/",
      // A rule id, which the public API cannot map to its workflow.
      "https://acme.sentry.io/alerts/rules/web/42/details/",
    ]) {
      expect(parseAlert(url)).toBeUndefined();
    }
  });
});
