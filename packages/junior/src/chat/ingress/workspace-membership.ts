import type { AppMentionEvent } from "@slack/types";
import type { StateAdapter } from "chat";
import { z } from "zod";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { parseSlackTeamId, parseSlackUserId } from "@/chat/slack/ids";
import { lookupSlackUserProfile } from "@/chat/slack/users";
import { createCache } from "@/chat/state/cache";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// Slack Connect admits external authors, but user_team is not guaranteed.
// Missing user_team must neither grant access nor block local authors.
// Resolve it through users.info instead.
// https://docs.slack.dev/reference/events/app_mention

// Avoid a lookup per message. Reads do not extend the five-minute window
// during which a changed membership can remain valid.
const MEMBER_TTL_MS = 5 * 60 * 1000;
const NON_MEMBER_TTL_MS = 30 * 1000;

// Slack defines these on AppMentionEvent, but not GenericMessageEvent.
// Chat SDK's SlackEvent omits both. Validate them before checking membership.
const authorTeamSchema = z.object({
  user_team: z.string().optional(),
  source_team: z.string().optional(),
  user: z.unknown().optional(),
}) satisfies z.ZodType<Pick<AppMentionEvent, "user_team" | "source_team">>;

/** Accept only verified workspace authors, reusing recent membership lookups. */
export async function isSlackWorkspaceMember(
  raw: unknown,
  state: StateAdapter,
): Promise<boolean> {
  const workspaceTeamId = getWorkspaceTeamId();
  if (!workspaceTeamId) return false;
  const parsed = authorTeamSchema.safeParse(raw);
  if (!parsed.success) return false;

  const event = parsed.data;
  const userId = parseSlackUserId(event.user);
  if (!userId) return false;
  const cache = createCache(state, "core");
  const key = `slack:membership:${workspaceTeamId}:${userId}`;
  const authorTeam = parseSlackTeamId(event.user_team);
  if (authorTeam === workspaceTeamId) return true;
  if (
    event.user_team !== undefined &&
    !authorTeam &&
    !/^E[A-Z0-9]+$/.test(event.user_team)
  ) {
    return false;
  }

  // event.team and envelope teams can describe the receiving workspace;
  // source_team describes message origin. Neither proves author membership.
  // https://docs.slack.dev/enterprise/developing-for-enterprise-orgs#events_api
  // Explicit external authors must override even a recent positive lookup.
  if (authorTeam !== undefined) {
    return await cache.getOrLoad(
      key,
      async () => ({ value: false, ttlMs: NON_MEMBER_TTL_MS }),
      { refresh: true },
    );
  }
  return await cache.getOrLoad(key, async () => {
    // External users in shared channels can have is_stranger: false.
    // https://docs.slack.dev/apis/slack-connect/#members
    const user = await lookupSlackUserProfile(userId);
    const authorTeam = parseSlackTeamId(user.team_id);
    // Do not cache failures or incomplete/mismatched user responses.
    if (user.id !== userId || !authorTeam) return { value: false };
    const member = authorTeam === workspaceTeamId && !user.is_deleted;
    return {
      value: member,
      ttlMs: member ? MEMBER_TTL_MS : NON_MEMBER_TTL_MS,
    };
  });
}
