import {
  SANDBOX_REPOS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import type { Workspace } from "@/chat/workspaces/types";

interface PrepareWorkspaceParams {
  sandbox: SandboxSession;
  workspace: Workspace;
  signal?: AbortSignal;
  applyNetworkPolicy(sandbox: SandboxSession): Promise<unknown>;
  prepareRepositories?(
    sandbox: SandboxSession,
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCredentialRoute: boolean;
}

/** Prepare repositories before a Workspace setup script starts. */
export async function prepareWorkspaceRepositories(
  params: PrepareWorkspaceParams,
): Promise<void> {
  const { sandbox, workspace, signal } = params;
  signal?.throwIfAborted();
  await params.applyNetworkPolicy(sandbox);
  await params.prepareRepositories?.(sandbox, workspace, signal);
  // Provider preparation uses credential egress. Remove that route before the
  // app-owned setup script runs and before the snapshot is captured.
  if (params.removeCredentialRoute) {
    await sandbox.update({ networkPolicy: "allow-all" });
  }
}

/** Build the command for one Workspace setup script. */
export function workspaceSetupCommand(workspace: Workspace) {
  return {
    cmd: "bash",
    args: ["-euo", "pipefail", "-c", workspace.setupScript],
    cwd: SANDBOX_WORKSPACE_ROOT,
    env: {
      JUNIOR_REPOS_ROOT: SANDBOX_REPOS_ROOT,
      JUNIOR_WORKSPACE_ROOT: SANDBOX_WORKSPACE_ROOT,
    },
  };
}

/** Prepare repositories and setup state before a Workspace snapshot is captured. */
export async function prepareWorkspaceSnapshot(
  params: PrepareWorkspaceParams,
): Promise<void> {
  const { sandbox, workspace, signal } = params;
  await prepareWorkspaceRepositories(params);
  if (!workspace.setupScript.trim()) return;
  const result = await sandbox.runCommand({
    ...workspaceSetupCommand(workspace),
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Workspace setup failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
}
