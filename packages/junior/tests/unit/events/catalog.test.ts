import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_NAMESPACE,
  automationEventCatalog,
  eventGuidance,
  requireEventIdentifier,
  type EventCatalog,
} from "@/chat/events/catalog";
import {
  eventAutomationTriggerAvailable,
  registeredEventAutomationTriggerSchema,
  requireSupportedEventAutomationTrigger,
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
      },
    ],
  },
  [CORE_EVENT_NAMESPACE]: workspaceSnapshotEvents(),
};

describe("event catalog", () => {
  it("scopes app guidance to the registered resource type", () => {
    expect(
      eventGuidance(
        catalog,
        "github",
        "pull_request",
        "pull_request.comment.created",
      ),
    ).toBe("Address actionable feedback.");
    expect(
      eventGuidance(
        catalog,
        "github",
        "repository",
        "pull_request.comment.created",
      ),
    ).toBeUndefined();
  });

  it("rejects an identifier that does not fit its resource type", () => {
    const declared: EventCatalog = {
      github: {
        resourceTypes: [
          {
            type: "issue",
            identifier: {
              template: "{owner}/{repo}#{number}",
              parts: {
                owner: { kind: "string", description: "owner" },
                repo: { kind: "string", description: "repository" },
                number: { kind: "number", description: "issue number" },
              },
            },
            supportedEvents: ["issue.closed"],
          },
          {
            type: "repository",
            identifier: {
              template: "{owner}/{repo}",
              parts: {
                owner: { kind: "string", description: "owner" },
                repo: { kind: "string", description: "repository" },
              },
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
    // A resource type without a declared format accepts any identifier.
    expect(identifier("release_source", "anything")).toBe("anything");
    expect(() => identifier("issue", "getsentry/junior")).toThrow(
      new ToolInputError(
        'Identifier "getsentry/junior" does not fit resourceType "issue" in namespace "github", which has the form "{owner}/{repo}#{number}". Expected "#" after "repo". If the identifier is correct, use one of these resourceType values: "repository".',
      ),
    );
    expect(() => identifier("issue", "getsentry/junior#latest")).toThrow(
      new ToolInputError(
        'Identifier "getsentry/junior#latest" does not fit resourceType "issue" in namespace "github", which has the form "{owner}/{repo}#{number}". "number" must be a positive whole number, such as 123.',
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
      requireSupportedEventAutomationTrigger(catalog, {
        namespace: CORE_EVENT_NAMESPACE,
        resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
        events: [WORKSPACE_SNAPSHOT_READY_EVENT],
      }),
    ).toThrow(ToolInputError);

    expect(
      eventAutomationTriggerAvailable(
        {
          id: "task-1",
          createdAtMs: 1,
          createdBy: {
            slackUserId: "U1",
          },
          creatorIdentityId: "identity-U1",
          credentialMode: "system",
          destination: {
            platform: "slack",
            teamId: "T1",
            channelId: "C1",
          },
          destinationVisibility: "public",
          outcomes: [],
          task: { text: "Switch when ready." },
          trigger: {
            namespace: CORE_EVENT_NAMESPACE,
            identifier: "11111111-1111-4111-8111-111111111111",
            resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
            label: "Workspace sentry snapshot",
            events: [WORKSPACE_SNAPSHOT_READY_EVENT],
          },
        },
        catalog,
      ),
    ).toBe(false);
  });
});
