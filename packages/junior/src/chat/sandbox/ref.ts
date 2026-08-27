/**
 * Handle for this conversation's current sandbox.
 * Acquire restores `id` first. Only switchWorkspace replaces it.
 * `profileHash` is what this sandbox was built from, not a freshness check.
 */
export interface SandboxRef {
  id: string;
  profileHash?: string;
  workspaceId?: string;
}
