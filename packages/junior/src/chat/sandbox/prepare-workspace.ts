import {
  SANDBOX_REPOS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import type { Workspace } from "@/chat/workspaces/types";

const WORKSPACE_SETUP_FAILURE_OUTPUT_MAX_CHARS = 7_000;
const WORKSPACE_SETUP_FAILURE_TRUNCATION_MARKER =
  "[earlier setup output truncated]\n";
// Sandboxes often report less memory to Node than they have. That default
// heap limit is too small for real build tools, so give setup scripts more
// room up front instead of failing with an out-of-memory error.
const WORKSPACE_SETUP_NODE_OPTIONS = "--max-old-space-size=4096";

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

/** Return bounded setup output for a Workspace failure. */
export function workspaceSetupFailureDetail(input: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  const output = [
    input.stdout.trim() ? `stdout:\n${input.stdout.trim()}` : "",
    input.stderr.trim() ? `stderr:\n${input.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!output) return `exit ${input.exitCode}`;
  if (output.length <= WORKSPACE_SETUP_FAILURE_OUTPUT_MAX_CHARS) return output;

  const keptChars =
    WORKSPACE_SETUP_FAILURE_OUTPUT_MAX_CHARS -
    WORKSPACE_SETUP_FAILURE_TRUNCATION_MARKER.length;
  return `${WORKSPACE_SETUP_FAILURE_TRUNCATION_MARKER}${output.slice(-keptChars)}`;
}

/** Build the env vars shared by every Workspace setup command. */
function workspaceSetupEnv(): Record<string, string> {
  return {
    JUNIOR_REPOS_ROOT: SANDBOX_REPOS_ROOT,
    JUNIOR_WORKSPACE_ROOT: SANDBOX_WORKSPACE_ROOT,
    NODE_OPTIONS: WORKSPACE_SETUP_NODE_OPTIONS,
  };
}

/** Build the command for one Workspace setup script. */
export function workspaceSetupCommand(workspace: Workspace) {
  return {
    cmd: "bash",
    args: ["-euo", "pipefail", "-c", workspace.setupScript],
    cwd: SANDBOX_WORKSPACE_ROOT,
    env: workspaceSetupEnv(),
  };
}

/** Build a restart-safe command for one Workspace snapshot setup script. */
export function workspaceSnapshotSetupCommand(
  workspace: Workspace,
  buildId: string,
) {
  const stateRoot = `/tmp/junior-snapshot-build-${buildId}`;
  const wrapper = [
    `mkdir -p "${stateRoot}"`,
    `exec 9>"${stateRoot}/lock"`,
    "flock 9",
    `if test -f "${stateRoot}/exit"; then exit "$(cat "${stateRoot}/exit")"; fi`,
    "set +e",
    'bash -euo pipefail -c "$1"',
    "status=$?",
    `printf '%s\\n' "$status" > "${stateRoot}/exit"`,
    'exit "$status"',
  ].join("\n");
  return {
    cmd: "bash",
    args: [
      "-euo",
      "pipefail",
      "-c",
      wrapper,
      "junior-setup",
      workspace.setupScript,
    ],
    cwd: SANDBOX_WORKSPACE_ROOT,
    env: workspaceSetupEnv(),
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
      `Workspace setup failed: ${workspaceSetupFailureDetail(result)}`,
    );
  }
}
