import { describe, expect, it } from "vitest";
import { eventMatches, stableEventMatchKey } from "@sentry/junior-plugin-api";
import {
  registeredEventTriggerProblems,
  requireValidEventTrigger,
  type EventCatalog,
} from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const catalog: EventCatalog = {
  github: {
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: [
          "pull_request.opened",
          "pull_request.comment.created",
        ],
        matchFields: {
          isDraft: {
            kind: "boolean",
            description: "true when the pull request is a draft",
          },
          base: {
            kind: "string",
            description: "base branch name",
            events: ["pull_request.opened"],
          },
          authors: {
            kind: "string",
            list: true,
            description: "commit author logins",
          },
          openerRole: {
            kind: "string",
            description: "opener repository role",
            enum: ["admin", "write"],
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

  it("matches list event values that include a match value", () => {
    const data = { authors: ["dcramer", "sentry-junior[bot]"] };
    expect(eventMatches({ authors: "dcramer" }, data)).toBe(true);
    expect(eventMatches({ authors: ["octocat", "dcramer"] }, data)).toBe(true);
    expect(eventMatches({ authors: "octocat" }, data)).toBe(false);
    expect(eventMatches({ authors: "dcramer" }, { authors: [] })).toBe(false);
  });

  it("treats list order as the same match key", () => {
    expect(stableEventMatchKey(undefined)).toBe("");
    expect(
      stableEventMatchKey({ base: ["main", "master"], isDraft: false }),
    ).toBe(stableEventMatchKey({ isDraft: false, base: ["master", "main"] }));
  });
});

describe("requireValidEventTrigger", () => {
  const trigger = (
    events: string[],
    match?: Parameters<typeof requireValidEventTrigger>[1]["match"],
    resourceType = "pull_request",
  ) => ({ events, match, namespace: "github", resourceType });
  const problems = (...args: Parameters<typeof trigger>) =>
    registeredEventTriggerProblems(catalog, trigger(...args)).map(
      ({ reason, field }) => ({ reason, field }),
    );

  it("accepts filters every selected event sets and removes repeated values", () => {
    expect(
      requireValidEventTrigger(
        catalog,
        trigger(["pull_request.opened"], {
          isDraft: false,
          base: ["main", "master", "main"],
          authors: "dcramer",
        }),
      ),
    ).toEqual({ isDraft: false, base: ["main", "master"], authors: "dcramer" });
  });

  it("rejects filters that a selected event never sets", () => {
    expect(
      problems(["pull_request.opened", "pull_request.comment.created"], {
        base: "main",
      }),
    ).toEqual([{ reason: "field_not_set", field: "base" }]);
    expect(() =>
      requireValidEventTrigger(
        catalog,
        trigger(["pull_request.opened", "pull_request.comment.created"], {
          base: "main",
        }),
      ),
    ).toThrow(
      new ToolInputError(
        'This github pull request trigger cannot be saved. "base" is not set on "pull_request.comment.created", so the trigger never runs on those events. Remove the filter or those events.',
      ),
    );
  });

  it("reports removed filters, unknown events, and wrong values", () => {
    // A filter a plugin renamed, such as the old authorUsername, is unknown.
    expect(
      problems(["pull_request.merged"], {
        authorUsername: "dcramer",
        isDraft: "yes",
        openerRole: "owner",
      }),
    ).toEqual([
      { reason: "unknown_event", field: undefined },
      { reason: "unknown_field", field: "authorUsername" },
      { reason: "invalid_value", field: "isDraft" },
      { reason: "invalid_value", field: "openerRole" },
    ]);
    expect(problems(["issue.opened"], { isDraft: false }, "issue")).toEqual([
      { reason: "unknown_field", field: "isDraft" },
    ]);
    expect(problems(["issue.opened"], undefined, "team")).toEqual([
      { reason: "unknown_resource_type", field: undefined },
    ]);
  });
});
