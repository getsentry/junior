/**
 * Durable handle for the sandbox this conversation already owns.
 * `id` pins the live VM. `profileHash` records what that VM was built from.
 * Acquire restores this pin first; only switchWorkspace replaces it.
 */
export interface SandboxRef {
  id: string;
  profileHash?: string;
  workspaceId?: string;
}
