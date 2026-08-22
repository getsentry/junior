import type {
  ResourceEvent,
  SubscribableResource,
} from "@sentry/junior-plugin-api";

/** Event group for Workspace snapshot builds. */
export const WORKSPACE_SNAPSHOT_NAMESPACE = "junior";
/** Event source for one Workspace snapshot build. */
export const WORKSPACE_SNAPSHOT_RESOURCE_TYPE = "workspace_snapshot";
export const WORKSPACE_SNAPSHOT_READY_EVENT = "workspace_snapshot.ready";
export const WORKSPACE_SNAPSHOT_FAILED_EVENT = "workspace_snapshot.failed";

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
    suggestedEvents: [
      WORKSPACE_SNAPSHOT_READY_EVENT,
      WORKSPACE_SNAPSHOT_FAILED_EVENT,
    ],
    type: WORKSPACE_SNAPSHOT_RESOURCE_TYPE,
  };
}

type WorkspaceSnapshotResult = {
  workspaceId: string;
  profileHash: string;
  occurredAtMs?: number;
} & (
  | { status: "ready"; buildId: string }
  | { status: "failed"; buildId?: string; error?: string | null }
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
  const eventId = input.buildId ?? input.profileHash;
  return {
    eventKey: `${WORKSPACE_SNAPSHOT_NAMESPACE}:${input.workspaceId}:${eventId}:${input.status}`,
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
    ...(input.status === "failed" && input.error
      ? { untrustedText: input.error }
      : {}),
  };
}
