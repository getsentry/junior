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
import { openSlackModal } from "@/chat/slack/outbound";
import {
  parseSlackMessageTs,
  slackMessageTsFromMs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import {
  buildSlackUserInputModal,
  parseSlackUserInputFormTarget,
  parseSlackUserInputSubmission,
  SLACK_USER_INPUT_VIEW_ID,
  slackUserInputAction,
  slackUserInputAnswerNote,
} from "@/chat/slack/user-input";
import {
  claimSlackUserInput,
  closeSlackUserInput,
  getOpenSlackUserInput,
  releaseSlackUserInput,
  type OpenSlackUserInput,
} from "@/chat/slack/user-input-state";
import {
  buttonUserInputField,
  formatUserInputAnswer,
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
} from "@/chat/tools/runtime/user-input-request";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
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
 * Save the first answer to the open request of a Slack thread as Slack input
 * from the person who answered. The input text is the formatted answer, so
 * the model reads one format on every surface. Later answers to the same
 * request do nothing. A stale request, such as one that a newer request
 * replaced, also does nothing.
 */
async function answerSlackUserInput(args: {
  adapter: SlackAdapter;
  answer: (open: OpenSlackUserInput) => UserInputAnswer;
  channelId: string;
  inputTs: SlackMessageTs;
  messageId: string;
  messageTs: SlackMessageTs;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
  threadTs: SlackMessageTs;
}): Promise<void> {
  const userId = requireSlackPayloadUserId(
    args.payload.user?.id,
    "Slack user input payload",
  );
  const open = await getOpenSlackUserInput(args.state, {
    channelId: args.channelId,
    threadTs: args.threadTs,
  });
  if (!open || open.messageTs !== args.messageTs) {
    return;
  }
  const answer = args.answer(open);
  if (isEmptyUserInputAnswer(answer)) {
    return;
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
  const { channelId, messageTs } = args;
  if (
    !(await claimSlackUserInput(args.state, { channelId, messageTs, userId }))
  ) {
    return;
  }

  const event = {
    type: "message",
    channel: channelId,
    team: args.payload.team?.id,
    text: formatUserInputAnswer(open.request, answer),
    thread_ts: args.threadTs,
    ts: args.inputTs,
    user: userId,
    user_team: userTeam,
  };
  const parsed = args.adapter.parseMessage(event);
  // The answer has no Slack message of its own. Give it a non-timestamp id
  // so every Slack timestamp reader, such as reactions, the actor
  // `slack_ts`, and attachment lookup, resolves `raw.ts`: the request
  // message. `inputTs` sets the time of the input.
  const message = new Message({
    attachments: parsed.attachments,
    author: parsed.author,
    formatted: parsed.formatted,
    id: args.messageId,
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
    // Junior did not save the answer, so let the person answer again.
    await releaseSlackUserInput(args.state, { channelId, messageTs });
    throw error;
  }

  await closeSlackUserInput({
    note: slackUserInputAnswerNote({ answer, request: open.request, userId }),
    open,
  });
}

/** Read the request message and thread of a block action. */
function blockActionTarget(payload: SlackInteractivePayload) {
  const channelId = parseSlackChannelId(payload.channel?.id);
  const messageTs = parseSlackMessageTs(payload.message?.ts);
  if (!channelId || !messageTs) {
    throw new Error("Slack user input payload is incomplete");
  }
  const threadTs = parseSlackMessageTs(payload.message?.thread_ts) ?? messageTs;
  return { channelId, messageTs, threadTs };
}

/** Answer a one-click request with the clicked choice. */
async function handleUserInputChoice(args: {
  action: NonNullable<SlackInteractivePayload["actions"]>[number];
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
}): Promise<void> {
  const target = blockActionTarget(args.payload);
  const actionTs = parseSlackMessageTs(args.action.action_ts);
  const choice = args.action.value?.trim();
  if (!actionTs || !choice) {
    throw new Error("Slack user input click payload is incomplete");
  }
  await answerSlackUserInput({
    ...target,
    adapter: args.adapter,
    answer: (open) => {
      const field = buttonUserInputField(open.request);
      return normalizeUserInputAnswer(open.request, {
        requestId: open.requestId,
        values: field ? { [field.id]: [choice] } : {},
      });
    },
    inputTs: actionTs,
    messageId: `slack-user-input-answer:${actionTs}`,
    payload: args.payload,
    persistMessage: args.persistMessage,
    state: args.state,
  });
}

/** Open the answer form of the open request for the person who clicked. */
async function handleUserInputOpenForm(args: {
  payload: SlackInteractivePayload;
  state: StateAdapter;
}): Promise<void> {
  const target = blockActionTarget(args.payload);
  const triggerId = args.payload.trigger_id;
  if (!triggerId) {
    throw new Error("Slack user input form payload is missing a trigger id");
  }
  const open = await getOpenSlackUserInput(args.state, target);
  if (!open || open.messageTs !== target.messageTs) {
    return;
  }
  await openSlackModal({
    triggerId,
    view: buildSlackUserInputModal(open.request, target),
  });
}

/** Answer a request with the values of its submitted form. */
async function handleUserInputSubmission(args: {
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
}): Promise<void> {
  const view = args.payload.view;
  const formTarget = parseSlackUserInputFormTarget(view?.private_metadata);
  const channelId = parseSlackChannelId(formTarget?.channelId);
  const messageTs = parseSlackMessageTs(formTarget?.messageTs);
  const threadTs = parseSlackMessageTs(formTarget?.threadTs);
  if (!view?.id || !channelId || !messageTs || !threadTs) {
    throw new Error("Slack user input form submission is incomplete");
  }
  const inputTs = slackMessageTsFromMs(Date.now());
  await answerSlackUserInput({
    adapter: args.adapter,
    answer: (open) =>
      parseSlackUserInputSubmission({
        request: open.request,
        requestId: open.requestId,
        values: view.state?.values ?? {},
      }),
    channelId,
    inputTs,
    messageId: `slack-user-input-answer:${view.id}`,
    messageTs,
    payload: args.payload,
    persistMessage: args.persistMessage,
    state: args.state,
    threadTs,
  });
}

/**
 * Handle Slack interactions from App Home and from user input requests:
 * block actions and submitted user input forms.
 */
export async function handleSlackInteractivePayload(args: {
  adapter: SlackAdapter;
  payload: SlackInteractivePayload;
  persistMessage: (message: Message) => Promise<void>;
  state: StateAdapter;
  userTokenStore: UserTokenStore;
}): Promise<void> {
  const spanAttributes = { userId: args.payload.user?.id?.trim() || undefined };
  if (
    args.payload.type === "view_submission" &&
    args.payload.view?.callback_id === SLACK_USER_INPUT_VIEW_ID
  ) {
    await withSpan(
      "chat.slack_user_input_submit",
      "chat.slack_user_input_submit",
      spanAttributes,
      () => handleUserInputSubmission(args),
    );
    return;
  }
  if (args.payload.type !== "block_actions") {
    return;
  }

  for (const action of args.payload.actions ?? []) {
    const kind = slackUserInputAction(action.action_id);
    if (kind === "choice") {
      await withSpan(
        "chat.slack_user_input_click",
        "chat.slack_user_input_click",
        spanAttributes,
        () => handleUserInputChoice({ ...args, action }),
      );
      return;
    }
    if (kind === "open_form") {
      await withSpan(
        "chat.slack_user_input_open_form",
        "chat.slack_user_input_open_form",
        spanAttributes,
        () => handleUserInputOpenForm(args),
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
