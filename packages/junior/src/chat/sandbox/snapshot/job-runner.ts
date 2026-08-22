/** Build Workspace snapshots in a background job. */
import type { ResourceEvent } from "@sentry/junior-plugin-api";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import { createPluginHookRunner } from "@/chat/plugins/agent-hooks";
import { ingestEventTasks } from "@/chat/event-tasks/ingest";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import { createResourceEventTeamIdResolver } from "@/chat/resource-events/workspace";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress/policy";
import { createSandboxEgressCredentialToken } from "@/chat/sandbox/egress/session";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { loadSnapshotsForProfile } from "@/chat/sandbox/snapshot/store";
import { isWorkspaceSnapshotNeedsMoreTimeError } from "@/chat/sandbox/snapshot/needs-more-time-error";
import { resolveWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { getWorkspace } from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";
import { workspaceSnapshotFinishedEvent } from "./events";
import {
  sendWorkspaceSnapshotJob,
  type WorkspaceSnapshotJobMessage,
} from "./job-queue";

const SNAPSHOT_BUILD_SYSTEM_ACTOR = {
  platform: "system",
  name: "workspace-snapshot",
} as const;

/** Leave time to send the next job before this request ends. */
const JOB_STOP_BUFFER_MS = 40_000;

const resolveResourceEventTeamId = createResourceEventTeamIdResolver();

async function publishSnapshotEvent(event: ResourceEvent): Promise<void> {
  const teamId = await resolveResourceEventTeamId();
  if (!teamId) {
    logInfo("workspace.snapshot.event.delivery.skipped", {
      "app.resource_event.namespace": event.namespace,
      "app.resource_event.event_type": event.eventType,
      "app.resource_event.reason": "multi_workspace",
    });
    return;
  }
  const queue = getVercelConversationWorkQueue();
  await Promise.all([
    ingestResourceEvent(event, { queue, teamId }),
    ingestEventTasks(event, { queue, teamId }),
  ]);
}

async function publishFinishedEvent(input: {
  workspace: Workspace;
  profileHash: string;
  buildId: string;
  status: "ready" | "failed";
  error?: string | null;
}): Promise<void> {
  await publishSnapshotEvent(
    workspaceSnapshotFinishedEvent({
      workspaceId: input.workspace.id,
      buildId: input.buildId,
      profileHash: input.profileHash,
      status: input.status,
      error: input.error,
    }),
  );
}

function createSnapshotBuildHelpers() {
  const credentials = credentialContextForActor(SNAPSHOT_BUILD_SYSTEM_ACTOR);
  const pluginHooks = createPluginHookRunner();
  const tokens = new Map<string, { expiresAtMs: number; token: string }>();
  const tokenFor = (egressId: string): string => {
    const cached = tokens.get(egressId);
    if (cached && cached.expiresAtMs > Date.now()) return cached.token;
    const now = Date.now();
    const token = createSandboxEgressCredentialToken({
      credentials,
      egressId,
      ttlMs: 60 * 60 * 1000,
    });
    tokens.set(egressId, { expiresAtMs: now + 60 * 60 * 1000, token });
    return token;
  };
  const applyNetworkPolicy = async (sandbox: SandboxSession) => {
    const networkPolicy = buildSandboxEgressNetworkPolicy({
      credentialToken: tokenFor(sandbox.sessionId),
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
      workspace,
      profileHash: value.hash,
      buildId: before.build?.id ?? before.ready.id,
      status: "ready",
    });
    return;
  }
  if (before.build?.status === "failed") {
    await publishFinishedEvent({
      workspace,
      profileHash: value.hash,
      buildId: before.build.id,
      status: "failed",
      error: before.build.error,
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
    if (isWorkspaceSnapshotNeedsMoreTimeError(error)) {
      await sendWorkspaceSnapshotJob(message);
      return;
    }
    const afterFailure = await loadSnapshotsForProfile(
      getDb(),
      workspace.id,
      value.hash,
    );
    if (afterFailure.build?.status === "failed") {
      await publishFinishedEvent({
        workspace,
        profileHash: value.hash,
        buildId: afterFailure.build.id,
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
      workspace,
      profileHash: value.hash,
      buildId: before.build?.id ?? after.build?.id ?? after.ready.id,
      status: "ready",
    });
    return;
  }
  if (after.build?.status === "failed") {
    await publishFinishedEvent({
      workspace,
      profileHash: value.hash,
      buildId: after.build.id,
      status: "failed",
      error: after.build.error,
    });
    return;
  }

  await sendWorkspaceSnapshotJob(message);
}

/** Start a snapshot build when no ready snapshot exists. */
export async function ensureWorkspaceSnapshotBuild(input: {
  workspace: Workspace;
}): Promise<{
  status: "ready" | "building" | "failed";
  profileHash: string;
  buildId?: string;
  error?: string | null;
}> {
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
  if (current.ready) {
    return { status: "ready", profileHash: value.hash };
  }
  if (current.build?.status === "failed") {
    return {
      status: "failed",
      profileHash: value.hash,
      buildId: current.build.id,
      error: current.build.error,
    };
  }

  await sendWorkspaceSnapshotJob({
    workspaceId: input.workspace.id,
    profileHash: value.hash,
  });

  return {
    status: "building",
    profileHash: value.hash,
    buildId: current.build?.id,
  };
}
