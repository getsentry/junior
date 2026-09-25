import type { AppMentionEvent } from "@slack/types";
import { z } from "zod";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { parseSlackUserId } from "@/chat/slack/ids";
import { lookupSlackUserProfile } from "@/chat/slack/users";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// Slack defines these on AppMentionEvent, but not GenericMessageEvent.
// Chat SDK's SlackEvent omits both. Validate them before checking membership.
const authorTeamSchema = z.object({
  user_team: z.string().optional(),
  source_team: z.string().optional(),
  user: z.unknown().optional(),
}) satisfies z.ZodType<Pick<AppMentionEvent, "user_team" | "source_team">>;

/** Accept only Slack authors whose home workspace matches the installation. */
export async function isSlackWorkspaceMember(raw: unknown): Promise<boolean> {
  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;
  const parsed = authorTeamSchema.safeParse(raw);
  if (!parsed.success) return false;

  // Use source_team only when user_team is absent, not when it is invalid.
  const authorTeam = parsed.data.user_team ?? parsed.data.source_team;
  if (authorTeam !== undefined) return authorTeam === workspaceTeamId;

  // Normal message events can omit both fields. The envelope's team_id is
  // the receiving workspace, not proof of the author's membership.
  const userId = parseSlackUserId(parsed.data.user);
  if (!userId) return false;
  const user = await lookupSlackUserProfile(userId);
  return user.id === userId && user.team_id === workspaceTeamId;
}
