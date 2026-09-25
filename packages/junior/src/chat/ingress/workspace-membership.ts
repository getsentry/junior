import type { AppMentionEvent } from "@slack/types";
import type { StateAdapter } from "chat";
import { z } from "zod";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { parseSlackTeamId, parseSlackUserId } from "@/chat/slack/ids";
import { lookupSlackUserProfile } from "@/chat/slack/users";
import { withLock } from "@/chat/state/locks";
export { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// Shared state is app-scoped; workspace and user IDs isolate installations.
// Reads do not renew expiry. A changed membership can remain valid for 5 minutes.
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
  const explicitlyExternal = authorTeam !== undefined;

  // Neither event.team, source_team, nor envelope context grants membership.
  // Explicit external authors must override even a recent positive lookup.
  if (!explicitlyExternal) {
    const cached = await state.get<boolean>(key);
    if (typeof cached === "boolean") return cached;
  }

  // Share one lookup across concurrent deliveries, including separate workers.
  const result = await withLock(
    state,
    `${key}:lookup`,
    async () => {
      if (explicitlyExternal) {
        await state.set(key, false, NON_MEMBER_TTL_MS);
        return false;
      }
      const cached = await state.get<boolean>(key);
      if (typeof cached === "boolean") return cached;
      const user = await lookupSlackUserProfile(userId);
      const authorTeam = parseSlackTeamId(user.team_id);
      // Do not cache failures or incomplete/mismatched user responses.
      if (user.id !== userId || !authorTeam) return false;
      const member = authorTeam === workspaceTeamId && !user.is_deleted;
      await state.set(key, member, member ? MEMBER_TTL_MS : NON_MEMBER_TTL_MS);
      return member;
    },
    { keepAlive: true, waitMs: 10_000 },
  );
  if (!result.acquired) {
    throw new Error("Could not acquire Slack membership lookup lock");
  }
  return result.value;
}
