import { describe, expect, it } from "vitest";
import {
  CORE_RESOURCE_EVENT_NAMESPACE,
  hasPluginResourceEventCatalogEntries,
  pluginResourceEventCatalog,
  resourceEventGuidance,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import {
  eventTaskTriggerAvailable,
  registeredEventTaskTriggerSchema,
  requireSupportedEventTaskTrigger,
} from "@/chat/event-tasks/tool-support";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  WORKSPACE_SNAPSHOT_FAILED_EVENT,
  WORKSPACE_SNAPSHOT_READY_EVENT,
  WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
  workspaceSnapshotResourceEvents,
} from "@/chat/sandbox/snapshot/events";

const catalog: ResourceEventCatalog = {
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
  [CORE_RESOURCE_EVENT_NAMESPACE]: workspaceSnapshotResourceEvents(),
};

describe("resource event catalog", () => {
  it("scopes app guidance to the registered resource type", () => {
    expect(
      resourceEventGuidance(
        catalog,
        "github",
        "pull_request",
        "pull_request.comment.created",
      ),
    ).toBe("Address actionable feedback.");
    expect(
      resourceEventGuidance(
        catalog,
        "github",
        "repository",
        "pull_request.comment.created",
      ),
    ).toBeUndefined();
  });

  it("keeps core snapshot events out of durable event-task selection", () => {
    const plugins = pluginResourceEventCatalog(catalog);
    expect(Object.keys(plugins)).toEqual(["github"]);
    expect(hasPluginResourceEventCatalogEntries(catalog)).toBe(true);
    expect(
      hasPluginResourceEventCatalogEntries({
        [CORE_RESOURCE_EVENT_NAMESPACE]: workspaceSnapshotResourceEvents(),
      }),
    ).toBe(false);

    expect(() =>
      registeredEventTaskTriggerSchema(catalog).parse({
        namespace: CORE_RESOURCE_EVENT_NAMESPACE,
        identifier: "11111111-1111-4111-8111-111111111111",
        resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
        label: "Workspace sentry snapshot",
        events: [
          WORKSPACE_SNAPSHOT_READY_EVENT,
          WORKSPACE_SNAPSHOT_FAILED_EVENT,
        ],
      }),
    ).toThrow(/Invalid input|Invalid option|Invalid enum value|No resource event namespaces/);

    expect(() =>
      requireSupportedEventTaskTrigger(catalog, {
        namespace: CORE_RESOURCE_EVENT_NAMESPACE,
        resourceType: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
        events: [WORKSPACE_SNAPSHOT_READY_EVENT],
      }),
    ).toThrow(ToolInputError);

    expect(
      eventTaskTriggerAvailable(
        {
          id: "task-1",
          createdAtMs: 1,
          createdBy: {
            slackUserId: "U1",
          },
          credentialMode: "system",
          destination: {
            platform: "slack",
            teamId: "T1",
            channelId: "C1",
          },
          destinationVisibility: "public",
          task: { text: "Switch when ready." },
          trigger: {
            namespace: CORE_RESOURCE_EVENT_NAMESPACE,
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
