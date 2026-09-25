import type { AppMentionEvent } from "@slack/types";
import { z } from "zod";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { parseSlackTeamId, parseSlackUserId } from "@/chat/slack/ids";
import { lookupSlackUserProfile } from "@/chat/slack/users";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// Slack defines these on AppMentionEvent, but not GenericMessageEvent.
// Chat SDK's SlackEvent omits both. Validate them before checking membership.
const authorTeamSchema = z.object({
  user_team: z.string().optional(),
  source_team: z.string().optional(),
  user: z.unknown().optional(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  team: z.string().optional(),
}) satisfies z.ZodType<Pick<AppMentionEvent, "user_team" | "source_team">>;

/** Accept only Slack authors whose home workspace matches the installation. */
export async function isSlackWorkspaceMember(raw: unknown): Promise<boolean> {
  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;
  const parsed = authorTeamSchema.safeParse(raw);
  if (!parsed.success) return false;

  const event = parsed.data;
  const userId = parseSlackUserId(event.user);
  if (!userId) return false;

  if (event.user_team !== undefined) {
    const authorTeam = parseSlackTeamId(event.user_team);
    if (authorTeam) return authorTeam === workspaceTeamId;
    // Slack can send an Enterprise ID here. It does not identify a workspace.
    if (!/^E[A-Z0-9]+$/.test(event.user_team)) return false;
  } else if (event.type === "message" && event.subtype === undefined) {
    // Bolt uses team for ordinary message authors. Do not apply this rule to
    // mentions: their team can name the receiving workspace for an external user.
    // https://github.com/slackapi/bolt-python/blob/eddc4766559e5dc623700015c70ea360d076dced/slack_bolt/request/internals.py#L121-L158
    const authorTeam = parseSlackTeamId(event.team);
    if (authorTeam) return authorTeam === workspaceTeamId;
  }

  // source_team identifies message origin, not necessarily user membership.
  // Missing author fields and Enterprise IDs require a user lookup. Neither
  // envelope team_id nor the channel's external-sharing flag proves membership.
  const user = await lookupSlackUserProfile(userId);
  return user.id === userId && user.team_id === workspaceTeamId;
}
