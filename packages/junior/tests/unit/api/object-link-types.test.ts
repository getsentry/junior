import {
  defineJuniorPlugin,
  type ObjectLinkFilter,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { findObjectLinkType } from "@/api/objects/link-types";
import { readObjectLinkTypes } from "@/api/objects/resolve";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";

function plugin(name: string, filters: ObjectLinkFilter[]) {
  return defineJuniorPlugin({
    manifest: { name, displayName: name, description: `${name} links` },
    objectLinks: [
      { filters, objectType: "item", resolve: async () => undefined },
    ],
  });
}

function ownerOf(url: string, plugins: ReturnType<typeof plugin>[]) {
  return findObjectLinkType(readObjectLinkTypes(plugins), new URL(url))?.owner;
}

describe("object link types", () => {
  afterEach(() => {
    setDashboardConversationLinkOptions(undefined);
  });

  it("picks the most specific filter", () => {
    const plugins = [
      plugin("any-path", [{ host: "docs.example.com" }]),
      plugin("subdomains", [{ host: "*.example.com", path: "/a/b" }]),
      plugin("prefix", [{ host: "docs.example.com", pathPrefix: "/a/" }]),
      plugin("long-prefix", [{ host: "docs.example.com", pathPrefix: "/a/b" }]),
      plugin("pattern", [{ host: "docs.example.com", pathPattern: "/a/*" }]),
      plugin("exact", [{ host: "docs.example.com", path: "/a/b" }]),
      plugin("http", [{ scheme: "http", host: "docs.example.com" }]),
    ];
    expect(
      [
        "https://docs.example.com/a/b/",
        "https://docs.example.com/a/c",
        "https://docs.example.com/a/bc/d",
        "https://docs.example.com/a/c/d",
        "https://docs.example.com/z",
        "https://api.example.com/a/b",
        "http://docs.example.com/a/b",
        "https://example.com/a/b",
      ].map((url) => ownerOf(url, plugins)),
    ).toEqual([
      "exact",
      "pattern",
      "long-prefix",
      "prefix",
      "any-path",
      "subdomains",
      "http",
      undefined,
    ]);
  });

  it("matches dashboard pages and mailto links to core types", () => {
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    const types = readObjectLinkTypes([]);
    expect(
      [
        "https://junior.example.com/conversations/slack%3AC1%3A1.2",
        "https://junior.example.com/conversations/a/b",
        "https://junior.example.com/people/alice%40example.com",
        "mailto:alice@example.com",
        "https://other.example.com/conversations/a",
      ].map((url) => findObjectLinkType(types, new URL(url))?.objectType),
    ).toEqual(["conversation", undefined, "person", "person", undefined]);
  });

  it("rejects two link types that claim the same URLs", () => {
    expect(() =>
      readObjectLinkTypes([
        plugin("first", [{ host: "x.com", pathPattern: "/*/status/*" }]),
        plugin("second", [{ host: "x.com", pathPattern: "/jack/*/*" }]),
      ]),
    ).toThrow(/"first\/item" and "second\/item" claim the same URLs/);
    expect(() =>
      readObjectLinkTypes([
        plugin("first", [{ host: "x.com", pathPattern: "/*/status/*" }]),
        plugin("second", [{ host: "x.com", pathPattern: "/*/likes/*" }]),
      ]),
    ).not.toThrow();

    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    expect(() =>
      readObjectLinkTypes([plugin("mail", [{ scheme: "mailto" }])]),
    ).toThrow(/"junior\/person" and "mail\/item"/);
  });
});
