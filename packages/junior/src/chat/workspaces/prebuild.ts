import { getDb } from "@/chat/db";
import { credentialContextForActor } from "@/chat/credentials/context";
import { logException, logInfo } from "@/chat/logging";
import { createPluginHookRunner } from "@/chat/plugins/agent-hooks";
import { createSandbox } from "@/chat/sandbox/sandbox";
import { listWorkspaces } from "@/chat/workspaces/store";
import type { WaitUntilFn } from "@/handlers/types";

const WORKSPACE_PREBUILD_ACTOR = {
  platform: "system",
  name: "workspace-prebuild",
} as const;

// One attempt per process. Snapshot cache still dedupes across instances.
let scheduled = false;

/** Build snapshots for Workspaces that opt into background prebuild work. */
export async function prebuildConfiguredWorkspaces(): Promise<void> {
  try {
    const workspaces = (await listWorkspaces(getDb())).filter(
      (workspace) => workspace.prebuild,
    );
    if (workspaces.length === 0) return;

    const hooks = createPluginHookRunner();
    logInfo("sandbox.workspace_prebuild.started", {
      "app.workspace.count": workspaces.length,
    });

    await Promise.all(
      workspaces.map(async (workspace) => {
        const sandbox = createSandbox({
          skills: [],
          referenceFiles: [],
          credentialEgress: credentialContextForActor(WORKSPACE_PREBUILD_ACTOR),
          prepareWorkspace: async (target, recipe, signal) =>
            await hooks.prepareWorkspace(target, recipe.repos, signal),
        });
        try {
          await sandbox.switchWorkspace(workspace);
          logInfo("sandbox.workspace_prebuild.completed", {
            "app.workspace.id": workspace.id,
          });
        } catch (error) {
          logException(error, "sandbox.workspace_prebuild.failed", {
            "app.workspace.id": workspace.id,
          });
        } finally {
          await sandbox.stop();
        }
      }),
    );
  } catch (error) {
    // Callers must stay up when SQL or sandbox prep is unavailable.
    logException(error, "sandbox.workspace_prebuild.failed");
  }
}

/**
 * Schedule Workspace prebuild once for this process.
 *
 * Call from a request-owned `waitUntil` (heartbeat). Vercel only extends
 * lifetime for work registered during a request.
 */
export function scheduleWorkspacePrebuilds(waitUntil: WaitUntilFn): void {
  if (scheduled) return;
  scheduled = true;
  waitUntil(prebuildConfiguredWorkspaces());
}
