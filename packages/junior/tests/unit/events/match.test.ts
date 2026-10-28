import { describe, expect, it } from "vitest";
import { eventMatches, stableEventMatchKey } from "@sentry/junior-plugin-api";
import {
  requireSupportedEventMatch,
  type EventCatalog,
} from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const catalog: EventCatalog = {
  github: {
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: ["pull_request.opened"],
        matchFields: {
          isDraft: {
            kind: "boolean",
            description: "true when the pull request is a draft",
          },
          base: {
            kind: "string",
            description: "base branch name",
          },
        },
      },
      {
        type: "issue",
        supportedEvents: ["issue.opened"],
      },
    ],
  },
};

describe("eventMatches", () => {
  it("matches exact values and list any-one entries", () => {
    expect(eventMatches(undefined, { isDraft: true })).toBe(true);
    expect(eventMatches({}, { isDraft: true })).toBe(true);
    expect(eventMatches({ isDraft: false }, { isDraft: false })).toBe(true);
    expect(eventMatches({ isDraft: false }, { isDraft: true })).toBe(false);
    expect(eventMatches({ isDraft: false }, undefined)).toBe(false);
    expect(eventMatches({ isDraft: false }, {})).toBe(false);
    expect(eventMatches({ base: ["main", "master"] }, { base: "main" })).toBe(
      true,
    );
    expect(
      eventMatches({ base: ["main", "master"] }, { base: "develop" }),
    ).toBe(false);
  });

  it("treats list order as the same match key", () => {
    expect(stableEventMatchKey(undefined)).toBe("");
    expect(
      stableEventMatchKey({ base: ["main", "master"], isDraft: false }),
    ).toBe(stableEventMatchKey({ isDraft: false, base: ["master", "main"] }));
  });
});

describe("requireSupportedEventMatch", () => {
  it("accepts declared fields and rejects unknown ones", () => {
    expect(
      requireSupportedEventMatch(catalog, {
        match: { isDraft: false, base: ["main", "master"] },
        namespace: "github",
        resourceType: "pull_request",
      }),
    ).toEqual({ isDraft: false, base: ["main", "master"] });

    expect(() =>
      requireSupportedEventMatch(catalog, {
        match: { isDraft: false },
        namespace: "github",
        resourceType: "issue",
      }),
    ).toThrow(ToolInputError);

    expect(() =>
      requireSupportedEventMatch(catalog, {
        match: { author: "dcramer" },
        namespace: "github",
        resourceType: "pull_request",
      }),
    ).toThrow(ToolInputError);
  });
});
