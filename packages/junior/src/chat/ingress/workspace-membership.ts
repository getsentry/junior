import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

/** Accept only Slack authors whose home workspace matches the installation. */
export function isSlackWorkspaceMember(
  raw: Record<string, unknown> | undefined,
): boolean {
  const workspaceTeamId = getWorkspaceTeamId();
  if (!raw || !workspaceTeamId) return false;

  // Use source_team only when user_team is absent, not when it is invalid.
  const authorTeam = raw.user_team ?? raw.source_team;
  return authorTeam === workspaceTeamId;
}
