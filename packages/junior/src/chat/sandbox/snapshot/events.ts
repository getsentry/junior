import type {
  PluginResourceEvents,
  ResourceEvent,
  SubscribableResource,
} from "@sentry/junior-plugin-api";

export const WORKSPACE_SNAPSHOT_NAMESPACE = "junior";
export const WORKSPACE_SNAPSHOT_RESOURCE_TYPE = "workspace_snapshot";
export const WORKSPACE_SNAPSHOT_READY_EVENT = "workspace_snapshot.ready";
export const WORKSPACE_SNAPSHOT_FAILED_EVENT = "workspace_snapshot.failed";

/**
 * Core catalog entry for Workspace snapshot ready and failed events.
 *
 * Uses the same registration shape as plugins so search, guidance, and tool
 * schemas treat these events like any other resource type.
 */
export function workspaceSnapshotResourceEvents(): PluginResourceEvents {
  return {
    resourceTypes: [
      {
        type: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
        supportedEvents: [
          WORKSPACE_SNAPSHOT_READY_EVENT,
          WORKSPACE_SNAPSHOT_FAILED_EVENT,
        ],
        // switchWorkspace already creates the temporary subscription.
        suggestedEvents: [],
        guidance: {
          [WORKSPACE_SNAPSHOT_READY_EVENT]:
            "Call switchWorkspace again with the same Workspace name. Do not create another watch when switchWorkspace already returned a subscription.",
          [WORKSPACE_SNAPSHOT_FAILED_EVENT]:
            "Report the snapshot failure. Do not keep waiting for this Workspace unless the user asks to retry.",
        },
      },
    ],
  };
}

/** Describe the events that report when a snapshot build ends. */
export function workspaceSnapshotWatch(input: {
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
    suggestedEvents: [],
    type: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
  };
}

type WorkspaceSnapshotResult = {
  workspaceId: string;
  resultId: string;
  occurredAtMs?: number;
} &
  (
    | { status: "ready" }
    | { status: "failed"; error?: string | null }
  );

/** Report that a Workspace snapshot build is ready or failed. */
export function workspaceSnapshotFinishedEvent(
  input: WorkspaceSnapshotResult,
): ResourceEvent {
  const occurredAtMs = input.occurredAtMs ?? Date.now();
  const eventType =
    input.status === "ready"
      ? WORKSPACE_SNAPSHOT_READY_EVENT
      : WORKSPACE_SNAPSHOT_FAILED_EVENT;
  const trustedSummary =
    input.status === "ready"
      ? "Workspace snapshot is ready."
      : "Workspace snapshot build failed.";
  const event: ResourceEvent = {
    eventKey: `${WORKSPACE_SNAPSHOT_NAMESPACE}:${input.workspaceId}:${input.resultId}:${input.status}`,
    eventType,
    identifier: input.workspaceId,
    namespace: WORKSPACE_SNAPSHOT_NAMESPACE,
    occurredAtMs,
    terminal: true,
    trustedSummary,
    data: {
      workspaceId: input.workspaceId,
      status: input.status,
    },
  };
  if (input.status === "failed" && input.error) {
    event.untrustedText = input.error;
  }
  return event;
}
