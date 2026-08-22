import type {
  PluginResourceEvents,
  ResourceEvent,
  SubscribableResource,
} from "@sentry/junior-plugin-api";

/** Core resource-event namespace for Workspace snapshot builds. */
export const WORKSPACE_SNAPSHOT_NAMESPACE = "junior";
/** Resource type published for one Workspace snapshot build. */
export const WORKSPACE_SNAPSHOT_RESOURCE_TYPE = "workspace_snapshot";
export const WORKSPACE_SNAPSHOT_READY_EVENT = "workspace_snapshot.ready";
export const WORKSPACE_SNAPSHOT_FAILED_EVENT = "workspace_snapshot.failed";

/** Register core Workspace snapshot resource events in the runtime catalog. */
export const workspaceSnapshotResourceEvents: PluginResourceEvents = {
  resourceTypes: [
    {
      type: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
      supportedEvents: [
        WORKSPACE_SNAPSHOT_READY_EVENT,
        WORKSPACE_SNAPSHOT_FAILED_EVENT,
      ],
      suggestedEvents: [
        WORKSPACE_SNAPSHOT_READY_EVENT,
        WORKSPACE_SNAPSHOT_FAILED_EVENT,
      ],
      guidance: {
        [WORKSPACE_SNAPSHOT_READY_EVENT]:
          "The Workspace snapshot is ready. Call switchWorkspace again with the same name.",
        [WORKSPACE_SNAPSHOT_FAILED_EVENT]:
          "The Workspace snapshot build failed. Inspect the trusted summary, then retry switchWorkspace only after fixing the cause.",
      },
    },
  ],
};

/** Build the model-facing subscribable handle for one Workspace snapshot. */
export function workspaceSnapshotSubscribable(input: {
  workspaceId: string;
  workspaceName: string;
}): SubscribableResource {
  return {
    identifier: input.workspaceId,
    label: `Workspace ${input.workspaceName} snapshot`,
    namespace: WORKSPACE_SNAPSHOT_NAMESPACE,
    supportedEvents: [
      WORKSPACE_SNAPSHOT_READY_EVENT,
      WORKSPACE_SNAPSHOT_FAILED_EVENT,
    ],
    suggestedEvents: [
      WORKSPACE_SNAPSHOT_READY_EVENT,
      WORKSPACE_SNAPSHOT_FAILED_EVENT,
    ],
    type: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
  };
}

/** Build a terminal ready/failed event for one Workspace snapshot build. */
export function workspaceSnapshotResourceEvent(input: {
  workspaceId: string;
  workspaceName: string;
  buildId: string;
  profileHash: string;
  outcome: "ready" | "failed";
  error?: string | null;
  occurredAtMs?: number;
}): ResourceEvent {
  const occurredAtMs = input.occurredAtMs ?? Date.now();
  const eventType =
    input.outcome === "ready"
      ? WORKSPACE_SNAPSHOT_READY_EVENT
      : WORKSPACE_SNAPSHOT_FAILED_EVENT;
  const trustedSummary =
    input.outcome === "ready"
      ? `Workspace ${input.workspaceName} snapshot is ready.`
      : `Workspace ${input.workspaceName} snapshot failed${
          input.error ? `: ${input.error}` : "."
        }`;
  return {
    eventKey: `${WORKSPACE_SNAPSHOT_NAMESPACE}:${input.workspaceId}:${input.buildId}:${input.outcome}`,
    eventType,
    identifier: input.workspaceId,
    namespace: WORKSPACE_SNAPSHOT_NAMESPACE,
    occurredAtMs,
    terminal: true,
    trustedSummary,
    data: {
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      buildId: input.buildId,
      profileHash: input.profileHash,
      outcome: input.outcome,
      ...(input.error ? { error: input.error } : {}),
    },
  };
}
