import type { AppMentionEvent, GenericMessageEvent } from "@slack/types";
import type { StateAdapter } from "chat";
import * as z from "zod";
import type { SlackChannelScope } from "@/chat/ingress/slack-payload";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import {
  parseSlackTeamId,
  parseSlackUserId,
  slackBotIdSchema,
  type SlackBotId,
  type SlackUserId,
} from "@/chat/slack/ids";
import { lookupSlackBot, lookupSlackUserProfile } from "@/chat/slack/users";
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
  return await isCachedWorkspaceUser(userId, workspaceTeamId, state);
}

// Resolve membership through users.info, cached per workspace and user.
async function isCachedWorkspaceUser(
  userId: SlackUserId,
  workspaceTeamId: string,
  state: StateAdapter,
): Promise<boolean> {
  const cache = createCache(state, "core");
  return await cache.getOrLoad(
    `slack:membership:${workspaceTeamId}:${userId}`,
    async () => {
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
    },
  );
}

type BotProfile = NonNullable<GenericMessageEvent["bot_profile"]>;

// What bots.info shows about a bot: a live bot with a bot user, a live
// classic integration with no bot user, or neither.
type SlackBotRecord =
  | { kind: "bot_user"; userId: SlackUserId }
  | { kind: "classic" }
  | { kind: "none" };

// A post with a bot ID and no user. Posts from current Slack apps carry
// bot_profile; posts from classic integrations do not.
// https://docs.slack.dev/reference/events/message/bot_message
const botPostSchema = z.object({
  bot_id: slackBotIdSchema,
  bot_profile: z
    .object({
      deleted: z.boolean(),
      id: z.string(),
      team_id: z.string(),
    })
    .optional() satisfies z.ZodType<
    Pick<BotProfile, "deleted" | "id" | "team_id"> | undefined
  >,
  user: z.undefined().optional(),
});

/**
 * Return the bot ID of a post from an app in this workspace that has a bot ID
 * and no user, or nothing. The channel must not be shared outside this
 * workspace or its Enterprise Grid org. When Slack names the bot's workspace,
 * in `bot_profile` or through the bot user of `bots.info`, it must be this
 * workspace. On Enterprise Grid, Slack must name it.
 */
export async function slackWorkspaceBotId(
  raw: unknown,
  channelScope: SlackChannelScope,
  state: StateAdapter,
): Promise<SlackBotId | undefined> {
  const workspaceTeamId = getWorkspaceTeamId();
  if (
    !workspaceTeamId ||
    (channelScope !== "workspace" && channelScope !== "enterprise")
  ) {
    return undefined;
  }
  const parsed = botPostSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const botId = parsed.data.bot_id;
  const profile = parsed.data.bot_profile;
  if (profile) {
    return profile.id === botId &&
      profile.team_id === workspaceTeamId &&
      !profile.deleted
      ? botId
      : undefined;
  }
  const cache = createCache(state, "core");
  const bot = await cache.getOrLoad<SlackBotRecord>(
    `slack:bot:${workspaceTeamId}:${botId}`,
    async () => {
      const bot = await lookupSlackBot(botId);
      if (!bot || bot.deleted) {
        return { value: { kind: "none" }, ttlMs: NON_MEMBER_TTL_MS };
      }
      // Do not cache incomplete responses.
      if (bot.id !== botId) return { value: { kind: "none" } };
      if (bot.user_id === undefined) {
        return { value: { kind: "classic" }, ttlMs: MEMBER_TTL_MS };
      }
      const userId = parseSlackUserId(bot.user_id);
      if (!userId) return { value: { kind: "none" } };
      return { value: { kind: "bot_user", userId }, ttlMs: MEMBER_TTL_MS };
    },
  );
  // A bot user is checked like any other author. A classic integration has
  // no bot user, so Slack does not name its workspace. Its post is accepted
  // on a workspace-only channel alone. On Enterprise Grid, a bot of another
  // workspace in the org could post in an org-shared channel, so such a post
  // runs nothing.
  const accepted =
    bot.kind === "bot_user"
      ? await isCachedWorkspaceUser(bot.userId, workspaceTeamId, state)
      : bot.kind === "classic" && channelScope === "workspace";
  return accepted ? botId : undefined;
}
