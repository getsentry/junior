import { describe, expect, it } from "vitest";
import {
  eventMatches,
  eventTriggerText,
  mergeEventMatchFields,
  stableEventMatchKey,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";
import {
  describeRegisteredEventTrigger,
  registeredEventTriggerProblems,
  requireValidEventTrigger,
  type EventCatalog,
} from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const catalog: EventCatalog = {
  github: {
    displayName: "GitHub",
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
        "event_automation",
      ),
    ).toEqual({ isDraft: false, base: ["main", "master"], authors: "dcramer" });
  });

  it("rejects filters that a selected event never sets", () => {
    expect(
      problems(["pull_request.opened", "pull_request.comment.created"], {
        base: "main",
      }),
    ).toEqual([{ reason: "field_not_set", field: "base" }]);
    const unmatchable = trigger(
      ["pull_request.opened", "pull_request.comment.created"],
      { base: "main" },
    );
    // The agent sees the input key, so it knows what to change.
    expect(() =>
      requireValidEventTrigger(catalog, unmatchable, "event_automation"),
    ).toThrow(
      new ToolInputError(
        'This GitHub pull request trigger cannot be saved. Filter "base" (match.base) is not set on "pull_request.comment.created", so it never matches those events. Remove the filter or those events.',
      ),
    );
    expect(() =>
      requireValidEventTrigger(catalog, unmatchable, "watch"),
    ).toThrow(/^This GitHub pull request watch cannot be created\. /);
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

describe("mergeEventMatchFields", () => {
  const pullRequestFields: EventMatchFields = {
    senderId: {
      kind: "number",
      description: "pull request commenter id",
      events: ["pull_request.comment.created"],
    },
  };

  it("keeps every event that sets a shared filter", () => {
    expect(
      mergeEventMatchFields(
        {
          senderId: {
            kind: "number",
            description: "issue commenter id",
            events: ["issue.comment.created"],
          },
        },
        pullRequestFields,
      ).senderId,
    ).toEqual({
      kind: "number",
      description: "issue commenter id",
      events: ["issue.comment.created", "pull_request.comment.created"],
    });
  });

  it("rejects a shared filter that describes different values", () => {
    expect(() =>
      mergeEventMatchFields(
        {
          senderId: {
            kind: "string",
            description: "issue commenter login",
            events: ["issue.comment.created"],
          },
        },
        pullRequestFields,
      ),
    ).toThrow('Match field "senderId" has a different kind, enum, or list');
    expect(() =>
      mergeEventMatchFields(
        { senderId: { kind: "number", description: "every commenter" } },
        pullRequestFields,
      ),
    ).toThrow('Match field "senderId" is in two maps');
  });
});

describe("describeRegisteredEventTrigger", () => {
  const trigger = {
    namespace: "github",
    resourceType: "pull_request",
    events: ["pull_request.opened"],
  };

  it("writes list fields as includes and other lists as or", () => {
    const description = describeRegisteredEventTrigger(catalog, {
      ...trigger,
      match: { authors: "alice", base: ["main", "release"], isDraft: false },
    });
    expect(description).toEqual({
      events: ["pull request opened"],
      filters: [
        "authors includes alice",
        "base is main or release",
        "isDraft is false",
      ],
      problems: [],
    });
    expect(eventTriggerText("Pull request", description)).toBe(
      "Pull request · pull request opened · filters: authors includes alice and base is main or release and isDraft is false",
    );
  });

  it("keeps the filters of a saved trigger that can no longer match", () => {
    expect(
      describeRegisteredEventTrigger(catalog, {
        ...trigger,
        match: { authorUsername: "dcramer" },
      }),
    ).toMatchObject({
      filters: ["authorUsername is dcramer"],
      problems: [
        expect.stringContaining('Filter "authorUsername" does not exist'),
      ],
    });
    expect(
      describeRegisteredEventTrigger(catalog, {
        ...trigger,
        resourceType: "team",
      }).problems,
    ).toEqual([
      '"team" is not an enabled resource type. Use one of: "pull_request", "issue".',
    ]);
  });
});
