import type { SlackAdapter } from "@chat-adapter/slack";
import { Message, type StateAdapter } from "chat";
import { parseActorUserId } from "@/chat/actor";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { logException, withSpan } from "@/chat/logging";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { parseSlackChannelId } from "@/chat/slack/ids";
import { updateSlackMessage } from "@/chat/slack/outbound";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import {
  buildAnsweredSlackUserInputBlocks,
  isSlackUserInputActionId,
} from "@/chat/slack/user-input";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import type { SlackInteractivePayload } from "./slack-payload";

// One answer per question. Keep the claim longer than people are likely to
// come back to an old thread.
const USER_INPUT_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function requireSlackPayloadUserId(
  value: string | null | undefined,
  source: string,
): string {
  const userId = parseActorUserId(value);
  if (!userId) {
    throw new Error(`${source} is missing a Slack user id`);
  }
  return userId;
}

async function handleAppHomeDisconnect(args: {
  provider: string;
  userId: string;
  userTokenStore: UserTokenStore;
}): Promise<void> {
  await withSpan(
    "chat.app_home_disconnect",
    "chat.app_home_disconnect",
    { userId: args.userId },
    async () => {
      try {
        await unlinkProvider(
          args.userId,
          args.provider,
          args.userTokenStore,
          getWorkspaceTeamId(),
        );
      } catch (error) {
        logException(error, "app_home.disconnect_unlink.failed", {
          "app.credential.provider": args.provider,
        });
      }

      try {
        await publishAppHomeView(
          getSlackClient(),
          args.userId,
          args.userTokenStore,
        );
      } catch (error) {
        logException(error, "app_home.disconnect_publish.failed", {
          "app.credential.provider": args.provider,
        });
      }
    },
  );
}

/**
 * Turn the first click on a choice of a user input request into Slack input
 * from the person who clicked. The input text is the choice label, the same
 * answer as typing it. Later clicks on the same question do nothing.
 */
async function handleUserInputClick(args: {
  action: NonNullable<SlackInteractivePayload["actions"]>[number];
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
}): Promise<void> {
  const userId = requireSlackPayloadUserId(
    args.payload.user?.id,
    "Slack user input click payload",
  );
  const channelId = parseSlackChannelId(args.payload.channel?.id);
  const messageTs = parseSlackMessageTs(args.payload.message?.ts);
  const actionTs = parseSlackMessageTs(args.action.action_ts);
  const answer = args.action.value?.trim();
  if (!channelId || !messageTs || !actionTs || !answer) {
    throw new Error("Slack user input click payload is incomplete");
  }
  const userTeam = args.payload.user?.team_id;
  if (
    !(await isSlackWorkspaceMember(
      { user: userId, user_team: userTeam },
      args.state,
    ))
  ) {
    return;
  }

  const claimKey = `slack:user-input-click:${channelId}:${messageTs}`;
  if (
    !(await args.state.setIfNotExists(
      claimKey,
      userId,
      USER_INPUT_CLAIM_TTL_MS,
    ))
  ) {
    return;
  }

  const threadTs =
    parseSlackMessageTs(args.payload.message?.thread_ts) ?? messageTs;
  const event = {
    type: "message",
    channel: channelId,
    team: args.payload.team?.id,
    text: answer,
    thread_ts: threadTs,
    ts: actionTs,
    user: userId,
    user_team: userTeam,
  };
  const parsed = args.adapter.parseMessage(event);
  // The click has no Slack message of its own. Give it a non-timestamp id so
  // every Slack timestamp reader, such as reactions, the actor `slack_ts`, and
  // attachment lookup, resolves `raw.ts`: the question message. `action_ts`
  // keeps the id unique per click and sets the time of the input.
  const message = new Message({
    attachments: parsed.attachments,
    author: parsed.author,
    formatted: parsed.formatted,
    id: `slack-user-input-click:${actionTs}`,
    isMention: true,
    links: parsed.links,
    metadata: parsed.metadata,
    raw: { ...event, ts: messageTs },
    text: parsed.text,
    threadId: parsed.threadId,
  });

  try {
    await args.persistMessage(message);
  } catch (error) {
    // Junior did not save the click, so let the person click again.
    await args.state.delete(claimKey);
    throw error;
  }

  try {
    await updateSlackMessage({
      blocks: buildAnsweredSlackUserInputBlocks({
        answer,
        blocks: args.payload.message?.blocks ?? [],
        userId,
      }),
      channelId,
      text: args.payload.message?.text?.trim() || answer,
      timestamp: messageTs,
    });
  } catch (error) {
    // The click is already saved. A stale button row is only cosmetic.
    logException(error, "slack.user_input.answer_update.failed", {
      "app.slack.channel_id": channelId,
      "app.slack.message_ts": messageTs,
    });
  }
}

/** Handle Slack block actions from App Home and from user input requests. */
export async function handleSlackInteractivePayload(args: {
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
  userTokenStore: UserTokenStore;
}): Promise<void> {
  if (args.payload.type !== "block_actions") {
    return;
  }

  const userInputAction = args.payload.actions?.find((candidate) =>
    isSlackUserInputActionId(candidate.action_id),
  );
  if (userInputAction) {
    await withSpan(
      "chat.slack_user_input_click",
      "chat.slack_user_input_click",
      { userId: args.payload.user?.id?.trim() || undefined },
      () =>
        handleUserInputClick({
          action: userInputAction,
          adapter: args.adapter,
          payload: args.payload,
          persistMessage: args.persistMessage,
          state: args.state,
        }),
    );
    return;
  }

  const disconnect = args.payload.actions?.find(
    (candidate) => candidate.action_id === "app_home_disconnect",
  );
  const provider = disconnect?.selected_option?.value ?? disconnect?.value;
  if (!provider) {
    return;
  }
  await handleAppHomeDisconnect({
    provider,
    userId: requireSlackPayloadUserId(
      args.payload.user?.id,
      "Slack app home disconnect payload",
    ),
    userTokenStore: args.userTokenStore,
  });
}
