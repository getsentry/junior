import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { slackAuthorTeamSchema } from "./slack-payload";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

/** Accept only Slack authors whose home workspace matches the installation. */
export function isSlackWorkspaceMember(raw: unknown): boolean {
  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;
  const parsed = slackAuthorTeamSchema.safeParse(raw);
  if (!parsed.success) return false;

  // Use source_team only when user_team is absent, not when it is invalid.
  const authorTeam = parsed.data.user_team ?? parsed.data.source_team;
  return authorTeam === workspaceTeamId;
}
