import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { setSpanAttributes } from "@/chat/logging";
import { getSandboxResources } from "@/chat/sandbox/resources";
import {
  isMissingError,
  resolve as resolveSnapshot,
  type Snapshot,
} from "@/chat/sandbox/snapshot/resolve";
import { rebuildMissingWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import type { Workspace } from "@/chat/workspaces/types";

interface SandboxCredentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

/** Create or rebuild a Sandbox session from one resolved snapshot pointer. */
export async function createSandboxFromResolvedSnapshot(params: {
  runtime: string;
  snapshot: Snapshot;
  sandboxCredentials: SandboxCredentials | undefined;
  sandboxName: string;
  signal?: AbortSignal;
  timeoutMs: number;
  workspace?: Workspace;
  prepareWorkspace?: (sandbox: SandboxSession) => Promise<void>;
  shouldYield?: () => boolean;
  turnDeadlineAtMs?: number;
  applyNetworkPolicy(sandbox: SandboxSession): Promise<unknown>;
  prepareRepositories?(
    sandbox: SandboxSession,
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCredentialRoute: boolean;
  preflightNetworkPolicy(sandboxName: string): NetworkPolicy | undefined;
  adaptSandbox(vercelSandbox: Sandbox): SandboxSession;
  createSandboxFromSnapshot(
    snapshotId: string,
    sandboxCredentials: SandboxCredentials | undefined,
    sandboxName: string,
    signal?: AbortSignal,
  ): Promise<SandboxSession>;
  sandboxFetchOptions(
    signal?: AbortSignal,
  ): { fetch: typeof globalThis.fetch } | Record<string, never>;
}): Promise<{ session: SandboxSession; snapshot: Snapshot }> {
  const { runtime, snapshot, sandboxCredentials, sandboxName, signal } =
    params;
  signal?.throwIfAborted();
  if (!snapshot.snapshotId) {
    const networkPolicy = params.preflightNetworkPolicy(sandboxName);
    const resources = getSandboxResources();
    return {
      snapshot,
      session: params.adaptSandbox(
        await Sandbox.create({
          timeout: params.timeoutMs,
          runtime,
          ...(networkPolicy
            ? { name: sandboxName, persistent: false, networkPolicy }
            : {}),
          ...(resources ? { resources } : {}),
          ...(sandboxCredentials ?? {}),
          ...params.sandboxFetchOptions(signal),
        }),
      ),
    };
  }

  const boot = async (next: Snapshot) => {
    if (!next.snapshotId) throw new Error("Missing sandbox snapshot id");
    signal?.throwIfAborted();
    return {
      snapshot: next,
      session: await params.createSandboxFromSnapshot(
        next.snapshotId,
        sandboxCredentials,
        sandboxName,
        signal,
      ),
    };
  };

  try {
    return await boot(snapshot);
  } catch (error) {
    if (!isMissingError(error)) throw error;
    setSpanAttributes({ "app.sandbox.snapshot.rebuild_after_missing": true });
    // Workspace recipes rebuild on the durable multi-slice path. Baseline
    // (no workspace) stays on the fast inline rebuild path.
    return await boot(
      params.workspace
        ? await rebuildMissingWorkspaceSnapshot({
            workspace: params.workspace,
            runtime,
            snapshotId: snapshot.snapshotId,
            signal,
            shouldYield: params.shouldYield,
            turnDeadlineAtMs: params.turnDeadlineAtMs,
            applyNetworkPolicy: params.applyNetworkPolicy,
            prepareRepositories: params.prepareRepositories,
            removeCredentialRoute: params.removeCredentialRoute,
          })
        : await resolveSnapshot({
            runtime,
            timeoutMs: params.timeoutMs,
            forceRebuild: true,
            staleSnapshotId: snapshot.snapshotId,
            signal,
            prepareWorkspace: params.prepareWorkspace,
          }),
    );
  }
}
