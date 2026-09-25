import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

/**
 * Accept only Slack authors whose home workspace matches the installation.
 * Missing workspace or author team data must not grant access. The event's
 * `team` and the envelope's `team_id` do not prove the author's membership.
 */
export function isSlackWorkspaceMember(
  raw: Record<string, unknown> | undefined,
): boolean {
  if (!raw) return false;

  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;

  // Use source_team only when user_team is absent, not when it is invalid.
  const authorTeam = raw.user_team ?? raw.source_team;
  return typeof authorTeam === "string" && authorTeam === workspaceTeamId;
}
