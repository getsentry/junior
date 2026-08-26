/** Build Workspace snapshots in a background job. */
import { credentialContextForActor } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import { createPluginHookRunner } from "@/chat/plugins/agent-hooks";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import { canRouteResourceEvents } from "@/chat/resource-events/workspace";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress/policy";
import { createSandboxEgressCredentialToken } from "@/chat/sandbox/egress/session";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { loadSnapshotsForProfile } from "@/chat/sandbox/snapshot/store";
import { isWorkspaceSnapshotNotReadyError } from "@/chat/sandbox/snapshot/not-ready-error";
import { resolveWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { getWorkspace } from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";
import { workspaceSnapshotFinishedEvent } from "./events";
import {
  sendNextWorkspaceSnapshotJob,
  sendWorkspaceSnapshotJob,
  type WorkspaceSnapshotJobMessage,
} from "./job-queue";

const SNAPSHOT_BUILD_SYSTEM_ACTOR = {
  platform: "system",
  name: "workspace-snapshot",
} as const;

/** Leave time to send the next job before this request ends. */
const JOB_STOP_BUFFER_MS = 40_000;

async function publishFinishedEvent(
  input: Parameters<typeof workspaceSnapshotFinishedEvent>[0],
): Promise<void> {
  const event = workspaceSnapshotFinishedEvent(input);
  if (!canRouteResourceEvents()) {
    logInfo("workspace.snapshot.event.delivery.skipped", {
      "app.resource_event.namespace": event.namespace,
      "app.resource_event.event_type": event.eventType,
      "app.resource_event.reason": "install_not_ready",
    });
    return;
  }
  const queue = getVercelConversationWorkQueue();
  await ingestResourceEvent(event, { queue });
}

function createSnapshotBuildHelpers() {
  const credentials = credentialContextForActor(SNAPSHOT_BUILD_SYSTEM_ACTOR);
  const pluginHooks = createPluginHookRunner();
  const applyNetworkPolicy = async (sandbox: SandboxSession) => {
    const networkPolicy = buildSandboxEgressNetworkPolicy({
      credentialToken: createSandboxEgressCredentialToken({
        credentials,
        egressId: sandbox.sessionId,
        ttlMs: 60 * 60 * 1000,
      }),
    });
    await sandbox.update({ networkPolicy });
    return networkPolicy;
  };
  const prepareRepositories = async (
    sandbox: SandboxSession,
    target: Workspace,
    signal?: AbortSignal,
  ) => {
    await pluginHooks.prepareWorkspace(sandbox, target.repos, signal);
  };
  return { applyNetworkPolicy, prepareRepositories };
}

function shouldStopJob(): boolean {
  const deadlineAtMs = getTurnRequestDeadline()?.deadlineAtMs;
  return (
    deadlineAtMs !== undefined &&
    Date.now() >= deadlineAtMs - JOB_STOP_BUFFER_MS
  );
}

/** Run a snapshot build and send another job if it needs more time. */
export async function processWorkspaceSnapshotJob(
  message: WorkspaceSnapshotJobMessage,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const workspace = await getWorkspace(getDb(), message.workspaceId);
  if (!workspace) {
    logInfo("workspace.snapshot.job.workspace_missing", {
      "app.workspace.id": message.workspaceId,
    });
    await publishFinishedEvent({
      workspaceId: message.workspaceId,
      resultId: message.profileHash,
      status: "failed",
    });
    return;
  }
  const value = profile.create(SANDBOX_RUNTIME, workspace);
  if (!value || value.hash !== message.profileHash) {
    logInfo("workspace.snapshot.job.profile_mismatch", {
      "app.workspace.id": workspace.id,
      "app.workspace.snapshot.profile_hash": message.profileHash,
    });
    return;
  }

  const before = await loadSnapshotsForProfile(
    getDb(),
    workspace.id,
    value.hash,
  );
  if (before.ready) {
    await publishFinishedEvent({
      workspaceId: workspace.id,
      resultId: before.ready.id,
      status: "ready",
    });
    return;
  }
  const { applyNetworkPolicy, prepareRepositories } =
    createSnapshotBuildHelpers();

  try {
    await resolveWorkspaceSnapshot({
      workspace,
      runtime: SANDBOX_RUNTIME,
      signal: options.signal,
      shouldStop: shouldStopJob,
      applyNetworkPolicy,
      prepareRepositories,
      removeCredentialRoute: true,
    });
  } catch (error) {
    if (isWorkspaceSnapshotNotReadyError(error)) {
      await sendNextWorkspaceSnapshotJob(message);
      return;
    }
    const afterFailure = await loadSnapshotsForProfile(
      getDb(),
      workspace.id,
      value.hash,
    );
    if (afterFailure.build?.status === "failed") {
      await publishFinishedEvent({
        workspaceId: workspace.id,
        resultId: afterFailure.build.id,
        status: "failed",
        error: afterFailure.build.error,
      });
      return;
    }
    throw error;
  }

  const after = await loadSnapshotsForProfile(
    getDb(),
    workspace.id,
    value.hash,
  );
  if (after.ready) {
    await publishFinishedEvent({
      workspaceId: workspace.id,
      resultId: after.ready.id,
      status: "ready",
    });
    return;
  }
  if (after.build?.status === "failed") {
    await publishFinishedEvent({
      workspaceId: workspace.id,
      resultId: after.build.id,
      status: "failed",
      error: after.build.error,
    });
    return;
  }

  await sendNextWorkspaceSnapshotJob(message);
}

/** Start a snapshot build when no ready snapshot exists. */
export async function ensureWorkspaceSnapshotBuild(input: {
  workspace: Workspace;
  sendAgain?: boolean;
}): Promise<"ready" | "building"> {
  const value = profile.create(SANDBOX_RUNTIME, input.workspace);
  if (!value) {
    throw new Error(
      `Workspace ${input.workspace.name} has no snapshot profile`,
    );
  }
  const current = await loadSnapshotsForProfile(
    getDb(),
    input.workspace.id,
    value.hash,
  );
  if (current.ready) return "ready";
  const message = {
    workspaceId: input.workspace.id,
    profileHash: value.hash,
  };
  if (input.sendAgain || current.build) {
    await sendNextWorkspaceSnapshotJob(message);
  } else {
    await sendWorkspaceSnapshotJob(message);
  }

  return "building";
}
