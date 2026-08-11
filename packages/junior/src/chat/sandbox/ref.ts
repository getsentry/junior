/** Durable opaque handle used to reopen a conversation's sandbox. */
export interface SandboxRef {
  id: string;
  profileHash?: string;
  workspaceId?: string;
}
