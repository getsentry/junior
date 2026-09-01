import { parseSlackUserId } from "@/chat/slack/ids";
import { lookupSlackUserProfile } from "@/chat/slack/users";

/** Return whether a Slack user can manage workspace-wide connections. */
export async function isSlackWorkspaceAdmin(userId: string): Promise<boolean> {
  const parsedUserId = parseSlackUserId(userId);
  if (!parsedUserId) {
    return false;
  }
  const profile = await lookupSlackUserProfile(parsedUserId);
  return Boolean(
    profile.is_admin || profile.is_owner || profile.is_primary_owner,
  );
}
