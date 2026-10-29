import type {
  CreateWorkspaceSnapshotBuilderInput,
  WorkspaceSnapshotBuilder,
} from "@/chat/sandbox/snapshot/workspace";
import { vercelSandboxProvider } from "@/chat/sandbox/vercel";
import type {
  CreateSandboxSessionInput,
  SandboxSession,
  SandboxSessionOptions,
} from "@/chat/sandbox/workspace";

// Module overview: the one place that chooses a sandbox provider.
//
// Sandbox code calls `getSandboxProvider()` and uses only this contract.
// Provider modules, such as `vercel.ts`, implement it. Only this module
// imports a provider module.

/** Sandbox lifecycle operations that each sandbox provider implements. */
export interface SandboxProvider {
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
  return vercelSandboxProvider;
}
