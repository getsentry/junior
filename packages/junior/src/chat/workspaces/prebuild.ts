import { getDb } from "@/chat/db";
import { credentialContextForActor } from "@/chat/credentials/context";
import { logException, logInfo } from "@/chat/logging";
import { createPluginHookRunner } from "@/chat/plugins/agent-hooks";
import { createSandbox } from "@/chat/sandbox/sandbox";
import { listWorkspaces } from "@/chat/workspaces/store";

const WORKSPACE_PREBUILD_ACTOR = {
  platform: "system",
  name: "workspace-prebuild",
} as const;

/** Build snapshots for Workspaces that opt into app-start background work. */
export async function prebuildConfiguredWorkspaces(): Promise<void> {
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
}
