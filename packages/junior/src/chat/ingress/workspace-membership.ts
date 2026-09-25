import type { AppMentionEvent } from "@slack/types";
import { z } from "zod";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// Slack defines these on AppMentionEvent, but not GenericMessageEvent.
// Chat SDK's SlackEvent omits both. Validate them before checking membership.
const authorTeamSchema = z.object({
  user_team: z.string().optional(),
  source_team: z.string().optional(),
}) satisfies z.ZodType<Pick<AppMentionEvent, "user_team" | "source_team">>;

/** Accept only Slack authors whose home workspace matches the installation. */
export function isSlackWorkspaceMember(raw: unknown): boolean {
  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;
  const parsed = authorTeamSchema.safeParse(raw);
  if (!parsed.success) return false;

  // Use source_team only when user_team is absent, not when it is invalid.
  const authorTeam = parsed.data.user_team ?? parsed.data.source_team;
  return authorTeam === workspaceTeamId;
}
