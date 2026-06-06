import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

/**
 * Return true when a Slack event's author is from an external workspace.
 *
 * In Slack Connect shared channels the inner event carries `user_team`
 * (the author's home workspace). When it differs from the outer payload's
 * `team_id` the author is a Slack Connect participant, not a local member.
 */
export function isExternalSlackUser(
  raw: Record<string, unknown> | undefined,
): boolean {
  if (!raw) return false;

  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;

  const userTeam =
    typeof raw.user_team === "string" ? raw.user_team : undefined;
  if (userTeam) return userTeam !== workspaceTeamId;

  const sourceTeam =
    typeof raw.source_team === "string" ? raw.source_team : undefined;
  if (sourceTeam) return sourceTeam !== workspaceTeamId;

  return false;
}
