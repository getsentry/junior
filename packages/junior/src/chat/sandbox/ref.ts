/** Sandbox this conversation is using. Reopen by `id`; only switchWorkspace replaces it. */
export interface SandboxRef {
  id: string;
  profileHash?: string;
  workspaceId?: string;
}
