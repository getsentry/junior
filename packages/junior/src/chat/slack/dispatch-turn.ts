import { Message, ThreadImpl } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import type {
  DispatchTurnContext,
  DispatchTurnResult,
} from "@/chat/agent-dispatch/types";
import { getStateAdapter } from "@/chat/state/adapter";
import type { DispatchRecord } from "@/chat/agent-dispatch/types";
import {
  getDispatchConversationId,
  getDispatchInputMessageId,
  getDispatchTurnId,
} from "@/chat/agent-dispatch/store";
import { buildDispatchRoutingContext } from "@/chat/agent-dispatch/work";
import { logWarn } from "@/chat/logging";
import { listThreadReplies } from "@/chat/slack/channel";
import { SLACK_MESSAGE_TS_METADATA_KEY } from "@/chat/slack/channel-message-events";
import { parseSlackChannelId } from "@/chat/slack/ids";
import {
  readSlackMessageFiles,
  slackFileAttachment,
  type SlackMessageFile,
} from "@/chat/slack/message-files";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";

type ExecuteSlackTurn = (
  thread: ThreadImpl,
  message: Message,
  options: {
    ack?: () => Promise<void>;
    conversationId?: string;
    destination: DispatchRecord["destination"];
    execution: DispatchTurnContext;
    onTurnDeliveryAccepted?: (messageId?: string) => void;
    onTurnOutcome?: (result: DispatchTurnResult) => void;
    shouldYield?: () => boolean;
    checkIn?: () => Promise<boolean>;
    skipBackfill?: boolean;
  },
) => Promise<void>;

/**
 * Read the files of the Slack message that started an Automation run.
 *
 * The dispatch record names the message, not its files, so the files come
 * from Slack and the record schema stays the same. A record that names no
 * message, or a message that Slack does not return, gives no files, and the
 * run starts with its text only.
 */
async function readDispatchTriggerFiles(
  dispatch: Pick<DispatchRecord, "destination" | "id" | "metadata" | "source">,
): Promise<SlackMessageFile[]> {
  // Plugins can set dispatch metadata too. Only core Event automations name
  // a Slack message with it.
  if (dispatch.source.kind !== "event_automation") return [];
  const messageTs = parseSlackMessageTs(
    dispatch.metadata?.[SLACK_MESSAGE_TS_METADATA_KEY],
  );
  const threadTs = parseSlackMessageTs(dispatch.destination.threadTs);
  const channelId = parseSlackChannelId(dispatch.destination.channelId);
  if (!messageTs || !threadTs || !channelId) return [];
  try {
    const replies = await listThreadReplies({
      channelId,
      threadTs,
      targetMessageTs: [messageTs],
    });
    const message = replies.find((reply) => reply.ts === messageTs);
    if (!message) {
      logWarn("agent.dispatch.trigger_message.missing", {
        "app.dispatch.id": dispatch.id,
        "messaging.message.id": messageTs,
      });
      return [];
    }
    return readSlackMessageFiles(message);
  } catch (error) {
    logWarn("agent.dispatch.trigger_message.read_failed", {
      "app.dispatch.id": dispatch.id,
      "error.type": error instanceof Error ? error.name : typeof error,
      "exception.message":
        error instanceof Error ? error.message : String(error),
      "messaging.message.id": messageTs,
    });
    return [];
  }
}

/**
 * Build the input Message of a dispatch run. The files of the Slack message
 * that started the run are its files, so the run stores them and the model
 * reads them as it reads the files of a person's message.
 */
function slackDispatchInputMessage(
  dispatch: DispatchRecord,
  files: SlackMessageFile[],
): Message {
  // TODO(dcramer): Remove this synthetic Slack Message after dispatch work
  // supplies Slack Delivery to the shared Turn path.
  const message = new Message({
    id: getDispatchInputMessageId(dispatch.id),
    threadId: getDispatchConversationId(dispatch),
    text: dispatch.input,
    attachments: files.map(slackFileAttachment),
    formatted: { type: "root", children: [] },
    metadata: {
      dateSent: new Date(dispatch.createdAtMs),
      edited: false,
    },
    raw: {
      channel: dispatch.destination.channelId,
      team: dispatch.destination.teamId,
      ...(dispatch.destination.threadTs
        ? { thread_ts: dispatch.destination.threadTs }
        : undefined),
      ...(files.length > 0 ? { files } : undefined),
    },
    author: {
      userId: dispatch.actor.name,
      userName: dispatch.actor.name,
      fullName: dispatch.actor.name,
      isBot: true,
      isMe: false,
    },
  });
  message.isMention = true;
  return message;
}

/** Build the Slack provider adapter for agent-dispatched conversation turns. */
export function createSlackDispatchTurnRunner(options: {
  getLocationConfiguration: (
    destination: DispatchRecord["destination"],
  ) => DispatchTurnContext["locationConfiguration"];
  getSlackAdapter: () => SlackAdapter;
  executeSlackTurn: ExecuteSlackTurn;
}) {
  return async function runSlackDispatchTurn(
    dispatch: DispatchRecord,
    hooks: {
      ack: () => Promise<void>;
      shouldYield?: () => boolean;
      checkIn?: () => Promise<boolean>;
    },
  ): Promise<DispatchTurnResult> {
    const state = getStateAdapter();
    await state.connect();
    const conversationId = getDispatchConversationId(dispatch);
    const adapter = options.getSlackAdapter();
    // TODO(dcramer): Remove this synthetic Slack Thread after dispatch work
    // supplies Slack Delivery to the shared Turn path.
    const message = slackDispatchInputMessage(
      dispatch,
      await readDispatchTriggerFiles(dispatch),
    );
    const thread = new ThreadImpl({
      adapter,
      stateAdapter: state,
      id: conversationId,
      channelId: dispatch.destination.channelId,
      channelVisibility:
        dispatch.destinationVisibility === "public" ? "workspace" : "private",
      currentMessage: message,
      initialMessage: message,
      isDM: dispatch.destination.channelId.startsWith("D"),
      isSubscribedContext: true,
    });

    let outcome: DispatchTurnResult["outcome"] | undefined;
    let errorMessage: string | undefined;
    let resultMessageTs: string | undefined;
    const routing = buildDispatchRoutingContext(dispatch);
    await options.executeSlackTurn(thread, message, {
      ack: hooks.ack,
      conversationId,
      destination: dispatch.destination,
      execution: {
        disabledFeatures: ["interactive-auth"],
        locationConfiguration: options.getLocationConfiguration(
          dispatch.destination,
        ),
        credentialContext: routing.credentialContext,
        dispatch: routing.dispatch,
        skipProviderDefaultConfig: true,
        source: dispatch.source,
        surface: routing.surface,
        turnId: getDispatchTurnId(dispatch.id),
      },
      onTurnDeliveryAccepted: (messageId) => {
        resultMessageTs = messageId;
      },
      onTurnOutcome: (result) => {
        outcome = result.outcome;
        errorMessage = result.errorMessage;
      },
      shouldYield: hooks.shouldYield,
      checkIn: hooks.checkIn,
      skipBackfill: true,
    });
    return {
      ...(errorMessage ? { errorMessage } : undefined),
      ...(outcome ? { outcome } : undefined),
      ...(resultMessageTs ? { resultMessageTs } : undefined),
    };
  };
}
