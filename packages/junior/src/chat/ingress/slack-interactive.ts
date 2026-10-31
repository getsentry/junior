import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message, StateAdapter } from "chat";
import { parseActorUserId } from "@/chat/actor";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { logException, withSpan } from "@/chat/logging";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import {
  parseSlackReviewItemClick,
  SLACK_REVIEW_ITEM_VIEW_ID,
} from "@/chat/slack/review-item-card";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  handleSlackReviewItemClick,
  handleSlackReviewItemSubmission,
} from "./slack-review-item";
import type { SlackInteractivePayload } from "./slack-payload";

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
 * Handle Slack interactions from App Home and Review item cards: block
 * actions and submitted forms.
 */
export async function handleSlackInteractivePayload(args: {
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  isAuthorAllowed: (userId: string) => Promise<boolean>;
  persistMessage: (message: Message) => Promise<void>;
  queue: ConversationWorkQueue;
  state: StateAdapter;
  userTokenStore: UserTokenStore;
}): Promise<void> {
  const spanAttributes = { userId: args.payload.user?.id?.trim() || undefined };
  if (
    args.payload.type === "view_submission" &&
    args.payload.view?.callback_id === SLACK_REVIEW_ITEM_VIEW_ID
  ) {
    await withSpan(
      "chat.slack_review_item_submit",
      "chat.slack_review_item_submit",
      spanAttributes,
      () =>
        handleSlackReviewItemSubmission({
          payload: args.payload,
          services: args,
        }),
    );
    return;
  }
  if (args.payload.type !== "block_actions") {
    return;
  }

  for (const action of args.payload.actions ?? []) {
    const click = parseSlackReviewItemClick(action);
    if (click) {
      await withSpan(
        "chat.slack_review_item_click",
        "chat.slack_review_item_click",
        spanAttributes,
        () =>
          handleSlackReviewItemClick({
            action,
            click,
            payload: args.payload,
            services: args,
          }),
      );
      return;
    }
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
