import { getDb } from "@/chat/db";
import { credentialContextForActor } from "@/chat/credentials/context";
import { logException, logInfo } from "@/chat/logging";
import { createPluginHookRunner } from "@/chat/plugins/agent-hooks";
import { createSandbox } from "@/chat/sandbox/sandbox";
import {
  getWorkspace,
  listWorkspaces,
} from "@/chat/workspaces/store";
import type { WorkspacePrebuildQueueMessage } from "./prebuild-message";
import { sendVercelWorkspacePrebuildTask } from "./prebuild-queue";

const WORKSPACE_PREBUILD_ACTOR = {
  platform: "system",
  name: "workspace-prebuild",
} as const;

// Remember successful enqueues in this process. Failed sends stay eligible for
// the next heartbeat. Queue idempotency and snapshot cache still dedupe work.
const enqueuedWorkspaceIds = new Set<string>();
let scheduleInFlight = false;

export interface ScheduleWorkspacePrebuildsOptions {
  send?: (message: WorkspacePrebuildQueueMessage) => Promise<void>;
}

/** Build one opted-in Workspace snapshot from a queue wakeup. */
export async function processWorkspacePrebuild(
  message: WorkspacePrebuildQueueMessage,
): Promise<void> {
  const workspace = await getWorkspace(getDb(), message.workspaceId);
  if (!workspace) {
    logInfo("sandbox.workspace_prebuild.skipped", {
      "app.workspace.id": message.workspaceId,
      "app.workspace.prebuild.skip_reason": "missing",
    });
    return;
  }
  if (!workspace.prebuild) {
    logInfo("sandbox.workspace_prebuild.skipped", {
      "app.workspace.id": workspace.id,
      "app.workspace.prebuild.skip_reason": "disabled",
    });
    return;
  }

  const hooks = createPluginHookRunner();
  const sandbox = createSandbox({
    skills: [],
    referenceFiles: [],
    credentialEgress: credentialContextForActor(WORKSPACE_PREBUILD_ACTOR),
    prepareWorkspace: async (target, recipe, signal) =>
      await hooks.prepareWorkspace(target, recipe.repos, signal),
  });
  try {
    logInfo("sandbox.workspace_prebuild.started", {
      "app.workspace.id": workspace.id,
    });
    await sandbox.switchWorkspace(workspace);
    logInfo("sandbox.workspace_prebuild.completed", {
      "app.workspace.id": workspace.id,
    });
  } catch (error) {
    logException(error, "sandbox.workspace_prebuild.failed", {
      "app.workspace.id": workspace.id,
    });
    throw error;
  } finally {
    await sandbox.stop();
  }
}

/**
 * Enqueue Workspace prebuild for this process.
 *
 * Heartbeat only schedules queue work. The queue callback owns the snapshot
 * build and its full function lifetime. Successful enqueues are remembered so
 * later heartbeats skip them; failed enqueues retry on the next pass.
 */
export async function scheduleWorkspacePrebuilds(
  options: ScheduleWorkspacePrebuildsOptions = {},
): Promise<void> {
  if (scheduleInFlight) return;
  scheduleInFlight = true;

  try {
    const workspaces = (await listWorkspaces(getDb())).filter(
      (workspace) =>
        workspace.prebuild && !enqueuedWorkspaceIds.has(workspace.id),
    );
    if (workspaces.length === 0) return;

    const send = options.send ?? sendVercelWorkspacePrebuildTask;
    logInfo("sandbox.workspace_prebuild.enqueued", {
      "app.workspace.count": workspaces.length,
    });
    await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          await send({ workspaceId: workspace.id });
          enqueuedWorkspaceIds.add(workspace.id);
        } catch (error) {
          logException(error, "sandbox.workspace_prebuild.enqueue.failed", {
            "app.workspace.id": workspace.id,
          });
        }
      }),
    );
  } catch (error) {
    // Callers must stay up when SQL is unavailable.
    logException(error, "sandbox.workspace_prebuild.schedule.failed");
  } finally {
    scheduleInFlight = false;
  }
}
