import { describe, expect, it } from "vitest";
import { parseSentryEventLink } from "../src/links/event-urls.js";

const ID = "0123456789abcdef0123456789abcdef";
const parse = (url: string) => parseSentryEventLink(new URL(url));

describe("Sentry event URLs", () => {
  it("reads a project event from each URL form Sentry redirects", () => {
    for (const url of [
      `https://sentry.io/organizations/acme/projects/web/events/${ID}/`,
      `https://acme.sentry.io/projects/web/events/${ID}/`,
      `https://sentry.io/acme/web/events/${ID}/`,
    ]) {
      expect(parse(url)).toEqual({ org: "acme", project: "web", eventId: ID });
    }
  });

  it("reads an event id with dashes as 32 hex digits", () => {
    expect(
      parse(
        "https://acme.sentry.io/projects/web/events/01234567-89AB-CDEF-0123-456789ABCDEF/",
      )?.eventId,
    ).toBe(ID);
  });

  it("ignores other pages", () => {
    for (const url of [
      `https://sentry.io/organizations/acme/events/${ID}/`,
      `https://sentry.io/organizations/acme/discover/web:${ID}/`,
      "https://acme.sentry.io/projects/web/events/latest/",
      `https://acme.sentry.io/projects/web/events/${ID}/json/`,
      `https://acme.sentry.io/issues/123/events/${ID}/`,
    ]) {
      expect(parse(url)).toBeUndefined();
    }
  });
});
