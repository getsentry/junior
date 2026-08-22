/**
 * Background Workspace snapshot builder.
 *
 * Runs outside the agent tool loop. Each queue delivery advances durable build
 * phases until ready/failed or the host request deadline requires requeue.
 */
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
import { isWorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import { resolveWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { getWorkspace } from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";
import { workspaceSnapshotResourceEvent } from "./events";
import type { WorkspaceSnapshotJobMessage } from "./job-message";
import { sendWorkspaceSnapshotJob } from "./job-queue";

const SNAPSHOT_BUILD_SYSTEM_ACTOR = {
  platform: "system",
  name: "workspace-snapshot",
} as const;

/** Leave time to requeue and acknowledge the queue message. */
const JOB_YIELD_BUFFER_MS = 40_000;

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

async function publishTerminalEvent(input: {
  workspace: Workspace;
  profileHash: string;
  buildId: string;
  outcome: "ready" | "failed";
  error?: string | null;
}): Promise<void> {
  await publishSnapshotEvent(
    workspaceSnapshotResourceEvent({
      workspaceId: input.workspace.id,
      workspaceName: input.workspace.name,
      buildId: input.buildId,
      profileHash: input.profileHash,
      outcome: input.outcome,
      error: input.error,
    }),
  );
}

function createSnapshotBuildHelpers(workspace: Workspace) {
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

function shouldYieldJob(): boolean {
  const deadlineAtMs = getTurnRequestDeadline()?.deadlineAtMs;
  return (
    deadlineAtMs !== undefined && Date.now() >= deadlineAtMs - JOB_YIELD_BUFFER_MS
  );
}

/**
 * Advance one Workspace snapshot build outside the agent loop.
 * Soft host yields requeue the same job; terminal outcomes publish events.
 */
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
    await publishTerminalEvent({
      workspace,
      profileHash: value.hash,
      buildId: before.build?.id ?? before.ready.id,
      outcome: "ready",
    });
    return;
  }
  if (before.build?.status === "failed") {
    await publishTerminalEvent({
      workspace,
      profileHash: value.hash,
      buildId: before.build.id,
      outcome: "failed",
      error: before.build.error,
    });
    return;
  }

  const { applyNetworkPolicy, prepareRepositories } =
    createSnapshotBuildHelpers(workspace);

  try {
    await resolveWorkspaceSnapshot({
      workspace,
      runtime: SANDBOX_RUNTIME,
      signal: options.signal,
      shouldYield: shouldYieldJob,
      applyNetworkPolicy,
      prepareRepositories,
      removeCredentialRoute: true,
    });
  } catch (error) {
    if (isWorkspaceSnapshotWaitingError(error)) {
      await sendWorkspaceSnapshotJob(message);
      return;
    }
    const afterFailure = await loadSnapshotsForProfile(
      getDb(),
      workspace.id,
      value.hash,
    );
    if (afterFailure.build?.status === "failed") {
      await publishTerminalEvent({
        workspace,
        profileHash: value.hash,
        buildId: afterFailure.build.id,
        outcome: "failed",
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
    await publishTerminalEvent({
      workspace,
      profileHash: value.hash,
      buildId: before.build?.id ?? after.build?.id ?? after.ready.id,
      outcome: "ready",
    });
    return;
  }
  if (after.build?.status === "failed") {
    await publishTerminalEvent({
      workspace,
      profileHash: value.hash,
      buildId: after.build.id,
      outcome: "failed",
      error: after.build.error,
    });
    return;
  }

  await sendWorkspaceSnapshotJob(message);
}

/** Ensure a durable snapshot build job is queued for one Workspace profile. */
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
