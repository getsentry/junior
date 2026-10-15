import type { SlackAdapter } from "@chat-adapter/slack";
import { Message, type StateAdapter } from "chat";
import { parseActorUserId } from "@/chat/actor";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { logException, withSpan } from "@/chat/logging";
import { publishAppHomeView } from "@/chat/slack/app-home";
import {
  buildAnsweredSlackButtonBlocks,
  formatSlackButtonClickText,
  isSlackButtonActionId,
} from "@/chat/slack/buttons";
import { getSlackClient } from "@/chat/slack/client";
import { parseSlackChannelId } from "@/chat/slack/ids";
import { updateSlackMessage } from "@/chat/slack/outbound";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import type { SlackInteractivePayload } from "./slack-payload";

// One answer per button message. Keep the claim longer than people are
// likely to come back to an old thread.
const BUTTON_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Turn the first click on a Junior button into Slack input from the person
 * who clicked. Later clicks on the same message do nothing.
 */
async function handleButtonClick(args: {
  action: NonNullable<SlackInteractivePayload["actions"]>[number];
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
}): Promise<void> {
  const userId = requireSlackPayloadUserId(
    args.payload.user?.id,
    "Slack button click payload",
  );
  const channelId = parseSlackChannelId(args.payload.channel?.id);
  const messageTs = parseSlackMessageTs(args.payload.message?.ts);
  const actionTs = parseSlackMessageTs(args.action.action_ts);
  const label = args.action.text?.text?.trim();
  const value = args.action.value;
  if (!channelId || !messageTs || !actionTs || !label || !value) {
    throw new Error("Slack button click payload is incomplete");
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

  const claimKey = `slack:button-click:${channelId}:${messageTs}`;
  if (
    !(await args.state.setIfNotExists(claimKey, userId, BUTTON_CLAIM_TTL_MS))
  ) {
    return;
  }

  const threadTs =
    parseSlackMessageTs(args.payload.message?.thread_ts) ?? messageTs;
  const event = {
    type: "message",
    channel: channelId,
    team: args.payload.team?.id,
    text: formatSlackButtonClickText({
      label,
      messageText: args.payload.message?.text,
      value,
    }),
    thread_ts: threadTs,
    ts: actionTs,
    user: userId,
    user_team: userTeam,
  };
  const parsed = args.adapter.parseMessage(event);
  // The click has no Slack message of its own. Its id uses action_ts, so it
  // sorts after earlier thread messages and stays apart from the button
  // message in history. Slack API calls for this input, such as the
  // processing reaction, need a real message, so `raw.ts` names the button
  // message.
  const message = new Message({
    attachments: parsed.attachments,
    author: parsed.author,
    formatted: parsed.formatted,
    id: parsed.id,
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
    // Let the person click again when Junior did not accept the click.
    await args.state.delete(claimKey);
    throw error;
  }

  try {
    await updateSlackMessage({
      blocks: buildAnsweredSlackButtonBlocks({
        blocks: args.payload.message?.blocks ?? [],
        label,
        userId,
      }),
      channelId,
      text: args.payload.message?.text?.trim() || label,
      timestamp: messageTs,
    });
  } catch (error) {
    // The click is already saved. A stale button row is only cosmetic.
    logException(error, "slack.buttons.answer_update.failed", {
      "app.slack.channel_id": channelId,
      "app.slack.message_ts": messageTs,
    });
  }
}

/** Handle Slack block actions from App Home and from Junior's buttons. */
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

  const buttonAction = args.payload.actions?.find((candidate) =>
    isSlackButtonActionId(candidate.action_id),
  );
  if (buttonAction) {
    await withSpan(
      "chat.slack_button_click",
      "chat.slack_button_click",
      { userId: args.payload.user?.id?.trim() || undefined },
      () =>
        handleButtonClick({
          action: buttonAction,
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
