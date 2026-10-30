import type {
  CreateWorkspaceSnapshotBuilderInput,
  WorkspaceSnapshotBuilder,
} from "@/chat/sandbox/snapshot/workspace";
import { getChatConfig } from "@/chat/config";
import { dockerSandboxProvider } from "@/chat/sandbox/docker/provider";
import { vercelSandboxProvider } from "@/chat/sandbox/vercel/provider";
import type {
  CreateSandboxSessionInput,
  SandboxSession,
  SandboxSessionOptions,
} from "@/chat/sandbox/workspace";

// Module overview: the one place that chooses a sandbox provider.
//
// Sandbox code calls `getSandboxProvider()` and uses only this contract.
// Provider modules, such as `vercel/provider.ts` and `docker/provider.ts`,
// implement it. `JUNIOR_SANDBOX_PROVIDER` selects one per deployment. Only this
// module imports a provider module.

/** Provider checks that sort its errors into the cases shared sandbox code handles. */
export interface SandboxErrorChecks {
  /** The current session is gone. Fail this operation and reacquire later. */
  isUnavailable(error: unknown): boolean;
  /** The named Sandbox no longer exists and cannot be resumed. */
  isMissing(error: unknown): boolean;
  /** Booting failed because the snapshot no longer exists. Rebuild it. */
  isSnapshotMissing(error: unknown): boolean;
  /** Booting failed because the snapshot is still being captured. Retry. */
  isSnapshotting(error: unknown): boolean;
  /** The provider API failed for a short time. Keep the job resumable. */
  isTransient(error: unknown): boolean;
  /** A command stream ended before the command reported an exit status. */
  isCommandStreamInterrupted(error: unknown): boolean;
}

/** Sandbox lifecycle operations that each sandbox provider implements. */
export interface SandboxProvider {
  /** Error checks for errors thrown by this provider's operations. */
  errors: SandboxErrorChecks;
  /** Create a Sandbox and return a session pinned to its first VM session. */
  createSession(input: CreateSandboxSessionInput): Promise<SandboxSession>;
  /** Resume a named Sandbox and return a session pinned to its VM session. */
  getSession(
    input: { name: string } & SandboxSessionOptions,
  ): Promise<SandboxSession>;
  /** Create the named, persistent Sandbox that owns one Workspace build. */
  createWorkspaceSnapshotBuilder(
    input: CreateWorkspaceSnapshotBuilderInput,
  ): Promise<void>;
  /** Resume the named Sandbox that owns one Workspace build. */
  getWorkspaceSnapshotBuilder(
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSnapshotBuilder>;
  /** Permanently delete named Workspace builders. Missing builders are ignored. */
  deleteWorkspaceSnapshotBuilders(names: Iterable<string>): Promise<void>;
}

/** Return the sandbox provider for this deployment. */
export function getSandboxProvider(): SandboxProvider {
  return getChatConfig().sandbox.provider === "docker"
    ? dockerSandboxProvider
    : vercelSandboxProvider;
}
