/**
 * Current sandbox for this conversation.
 * Restore `id` first. Only switchWorkspace replaces it.
 */
export interface SandboxRef {
  id: string;
  profileHash?: string;
  workspaceId?: string;
}
