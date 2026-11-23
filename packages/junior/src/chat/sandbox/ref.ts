/** Sandbox this conversation is using. Reopen by `id`; only switchWorkspace replaces it. */
export interface SandboxRef {
  id: string;
  profileHash?: string;
  workspaceId?: string;
  /**
   * Sandbox and VM session of the last sandbox tool call. A later tool call
   * on another session uses it to tell the agent that earlier files are gone.
   */
  toolSession?: { sandboxId: string; sessionId: string };
}
