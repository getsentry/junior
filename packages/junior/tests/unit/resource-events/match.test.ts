import { describe, expect, it } from "vitest";
import {
  resourceEventMatches,
  stableResourceEventMatchKey,
} from "@sentry/junior-plugin-api";
import {
  requireSupportedResourceEventMatch,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const catalog: ResourceEventCatalog = {
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

describe("resourceEventMatches", () => {
  it("matches exact facts and any-of lists", () => {
    expect(resourceEventMatches(undefined, { isDraft: true })).toBe(true);
    expect(resourceEventMatches({}, { isDraft: true })).toBe(true);
    expect(resourceEventMatches({ isDraft: false }, { isDraft: false })).toBe(
      true,
    );
    expect(resourceEventMatches({ isDraft: false }, { isDraft: true })).toBe(
      false,
    );
    expect(resourceEventMatches({ isDraft: false }, undefined)).toBe(false);
    expect(resourceEventMatches({ isDraft: false }, {})).toBe(false);
    expect(
      resourceEventMatches({ base: ["main", "master"] }, { base: "main" }),
    ).toBe(true);
    expect(
      resourceEventMatches({ base: ["main", "master"] }, { base: "develop" }),
    ).toBe(false);
  });

  it("treats any-of array order as the same match key", () => {
    expect(stableResourceEventMatchKey(undefined)).toBe("");
    expect(
      stableResourceEventMatchKey({ base: ["main", "master"], isDraft: false }),
    ).toBe(
      stableResourceEventMatchKey({ isDraft: false, base: ["master", "main"] }),
    );
  });
});

describe("requireSupportedResourceEventMatch", () => {
  it("accepts declared fields and rejects unknown ones", () => {
    expect(
      requireSupportedResourceEventMatch(catalog, {
        match: { isDraft: false, base: ["main", "master"] },
        namespace: "github",
        resourceType: "pull_request",
      }),
    ).toEqual({ isDraft: false, base: ["main", "master"] });

    expect(() =>
      requireSupportedResourceEventMatch(catalog, {
        match: { isDraft: false },
        namespace: "github",
        resourceType: "issue",
      }),
    ).toThrow(ToolInputError);

    expect(() =>
      requireSupportedResourceEventMatch(catalog, {
        match: { author: "dcramer" },
        namespace: "github",
        resourceType: "pull_request",
      }),
    ).toThrow(ToolInputError);
  });
});
