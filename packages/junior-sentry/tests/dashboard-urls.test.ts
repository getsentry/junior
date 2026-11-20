import { describe, expect, it } from "vitest";
import { parseSentryDashboardLink } from "../src/links/dashboard-urls.js";

const parse = (url: string) => parseSentryDashboardLink(new URL(url));
const NO_FILTERS = { project: [], environment: [], release: [] };

describe("Sentry dashboard URLs", () => {
  it("reads a dashboard from each URL form Sentry serves", () => {
    for (const url of [
      "https://sentry.io/organizations/acme/dashboard/42/",
      "https://sentry.io/organizations/acme/dashboards/42/",
      "https://acme.sentry.io/dashboard/42/",
      "https://acme.sentry.io/dashboards/42/",
    ]) {
      expect(parse(url)).toEqual({
        org: "acme",
        dashboardId: 42,
        filters: NO_FILTERS,
      });
    }
  });

  it("reads a widget by its index on the dashboard", () => {
    for (const url of [
      "https://sentry.io/organizations/acme/dashboard/42/widget/0/",
      "https://acme.sentry.io/dashboard/42/widget/0/",
    ]) {
      expect(parse(url)).toMatchObject({ dashboardId: 42, widgetIndex: 0 });
    }
  });

  it("reads the page filters that replace the saved ones", () => {
    expect(
      parse(
        "https://acme.sentry.io/dashboard/42/?project=11&project=-1&project=web&environment=production&release=web%401.0&statsPeriod=24h",
      )?.filters,
    ).toEqual({
      project: ["11", "-1"],
      environment: ["production"],
      release: ["web@1.0"],
      range: { statsPeriod: "24h" },
    });
  });

  it("keeps the saved period when the URL range is not valid", () => {
    for (const query of [
      "statsPeriod=",
      "statsPeriod=soon",
      "start=2026-11-14T12:00:00&end=2026-11-14T10:00:00",
    ]) {
      expect(
        parse(`https://acme.sentry.io/dashboard/42/?${query}`)?.filters,
      ).toEqual(NO_FILTERS);
    }
  });

  it("ignores other pages", () => {
    for (const url of [
      "https://acme.sentry.io/dashboards/",
      "https://acme.sentry.io/dashboards/new/",
      "https://acme.sentry.io/dashboard/default-overview/",
      "https://acme.sentry.io/dashboard/42/widget-builder/widget/0/edit/",
      "https://acme.sentry.io/dashboard/42/widget/new/",
      "https://acme.sentry.io/dashboards/42/widget/0/",
      "https://acme.sentry.io/dashboard/42/widget/0/extra/",
    ]) {
      expect(parse(url)).toBeUndefined();
    }
  });
});
