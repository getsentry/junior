import type { User } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { createSlackActor, parseActorUserId } from "@/chat/actor";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { parseSlackTeamId, type SlackTeamId } from "@/chat/slack/ids";
import type { SlackInteractivePayload } from "./slack-payload";

/**
 * Resolve the Junior User of the person who clicked a Slack control. The
 * click acts as that person, so it needs the same workspace and allowed
 * domain checks as a Slack mention. A person Junior does not know yet gets
 * a note to sign in.
 */
export async function resolveSlackActingUser(args: {
  isAuthorAllowed: (userId: string) => Promise<boolean>;
  payload: SlackInteractivePayload;
  state: StateAdapter;
  tell: (slackUserId: string, text: string) => Promise<unknown>;
}): Promise<
  { slackUserId: string; teamId: SlackTeamId; user: User } | undefined
> {
  const { payload } = args;
  const slackUserId = parseActorUserId(payload.user?.id);
  const teamId = parseSlackTeamId(payload.team?.id ?? payload.user?.team_id);
  if (!slackUserId || !teamId) {
    throw new Error("Slack interaction payload is missing a user or team");
  }
  if (
    !(await isSlackWorkspaceMember(
      { user: slackUserId, user_team: payload.user?.team_id },
      args.state,
    )) ||
    !(await args.isAuthorAllowed(slackUserId))
  ) {
    return undefined;
  }
  const user = (
    await readActorIdentity(createSlackActor(teamId, slackUserId, undefined))
  )?.user;
  if (!user) {
    await args.tell(
      slackUserId,
      "Junior does not know your account yet. Sign in to the Junior dashboard, then try again.",
    );
    return undefined;
  }
  return { slackUserId, teamId, user };
}
