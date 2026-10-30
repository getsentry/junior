import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_NAMESPACE,
  automationEventCatalog,
  eventGuidance,
  requireEventIdentifier,
  type EventCatalog,
} from "@/chat/events/catalog";
import {
  describeEventAutomationTrigger,
  registeredEventAutomationTriggerSchema,
  requireEventAutomationTrigger,
} from "@/chat/event-automations/tool-support";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  WORKSPACE_SNAPSHOT_FAILED_EVENT,
  WORKSPACE_SNAPSHOT_READY_EVENT,
  WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
  workspaceSnapshotEvents,
} from "@/chat/sandbox/snapshot/events";

const catalog: EventCatalog = {
  github: {
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: ["pull_request.comment.created"],
        guidance: {
          "pull_request.comment.created": "Address actionable feedback.",
        },
      },
      {
        type: "repository",
        supportedEvents: ["pull_request.comment.created"],
        guidance: {
          "pull_request.comment.created": "Address actionable feedback.",
        },
      },
    ],
  },
  [CORE_EVENT_NAMESPACE]: workspaceSnapshotEvents(),
};

describe("event catalog", () => {
  it("gives one guidance per event and rejects resource types that disagree", () => {
    expect(
      eventGuidance(catalog, "github", "pull_request.comment.created"),
    ).toBe("Address actionable feedback.");
    const disagreeing: EventCatalog = {
      github: {
        resourceTypes: [
          ...catalog.github!.resourceTypes.slice(0, 1),
          {
            type: "repository",
            supportedEvents: ["pull_request.comment.created"],
          },
        ],
      },
    };
    expect(() =>
      eventGuidance(disagreeing, "github", "pull_request.comment.created"),
    ).toThrow(
      'Resource types "pull_request", "repository" give different guidance for "pull_request.comment.created".',
    );
  });

  it("rejects an identifier that does not fit its resource type", () => {
    const declared: EventCatalog = {
      github: {
        resourceTypes: [
          {
            type: "issue",
            identifier: {
              format: "owner/repo#number",
              pattern: String.raw`^\S+#\d+$`,
            },
            supportedEvents: ["issue.closed"],
          },
          {
            type: "repository",
            identifier: {
              format: "owner/repo",
              pattern: String.raw`^[^\s#]+$`,
            },
            supportedEvents: ["issue.closed"],
          },
          { type: "release_source", supportedEvents: ["release.published"] },
        ],
        normalizeIdentifier: (identifier) => identifier.toLowerCase(),
      },
    };
    const identifier = (resourceType: string, value: string) =>
      requireEventIdentifier(declared, {
        namespace: "github",
        resourceType,
        identifier: value,
      });

    expect(identifier("issue", "Getsentry/Junior#208")).toBe(
      "getsentry/junior#208",
    );
    // A resource type without a declared shape accepts any identifier.
    expect(identifier("release_source", "anything")).toBe("anything");
    expect(() => identifier("issue", "getsentry/junior")).toThrow(
      new ToolInputError(
        'Identifier "getsentry/junior" does not fit resourceType "issue" in namespace "github". Expected format: "owner/repo#number". If the identifier is correct, use one of these resourceType values: "repository".',
      ),
    );
  });

  it("keeps core snapshot events out of durable event-automation selection", () => {
    const plugins = automationEventCatalog(catalog);
    expect(Object.keys(plugins)).toEqual(["github"]);

    expect(() =>
      registeredEventAutomationTriggerSchema(catalog).parse({
        namespace: CORE_EVENT_NAMESPACE,
        identifier: "11111111-1111-4111-8111-111111111111",
        resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
        label: "Workspace sentry snapshot",
        events: [
          WORKSPACE_SNAPSHOT_READY_EVENT,
          WORKSPACE_SNAPSHOT_FAILED_EVENT,
        ],
      }),
    ).toThrow(
      /Invalid input|Invalid option|Invalid enum value|No event namespaces/,
    );

    expect(() =>
      requireEventAutomationTrigger(catalog, {
        namespace: CORE_EVENT_NAMESPACE,
        identifier: "11111111-1111-4111-8111-111111111111",
        resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
        label: "Workspace sentry snapshot",
        events: [WORKSPACE_SNAPSHOT_READY_EVENT],
      }),
    ).toThrow(ToolInputError);

    // Snapshot events never dispatch event automations.
    expect(
      describeEventAutomationTrigger(
        {
          namespace: CORE_EVENT_NAMESPACE,
          identifier: "11111111-1111-4111-8111-111111111111",
          resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
          label: "Workspace sentry snapshot",
          events: [WORKSPACE_SNAPSHOT_READY_EVENT],
        },
        catalog,
      ).problems,
    ).toEqual(["The plugin for this source is not enabled."]);
  });
});
