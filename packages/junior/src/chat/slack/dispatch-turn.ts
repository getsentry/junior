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

interface DispatchReplyToThread {
  (
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
      skipBackfill?: boolean;
    },
  ): Promise<void>;
}

/** Build the Slack provider adapter for agent-dispatched conversation turns. */
export function createSlackDispatchTurnRunner(options: {
  getChannelConfiguration: (
    channelId: string,
  ) => DispatchTurnContext["channelConfiguration"];
  getSlackAdapter: () => SlackAdapter;
  replyToThread: DispatchReplyToThread;
}) {
  return async function runSlackDispatchTurn(
    dispatch: DispatchRecord,
    hooks: {
      ack: () => Promise<void>;
      shouldYield?: () => boolean;
    },
  ): Promise<DispatchTurnResult> {
    const state = getStateAdapter();
    await state.connect();
    const conversationId = getDispatchConversationId(dispatch);
    const adapter = options.getSlackAdapter();
    const message = new Message({
      id: getDispatchInputMessageId(dispatch.id),
      threadId: conversationId,
      text: dispatch.input,
      attachments: [],
      formatted: { type: "root", children: [] },
      metadata: {
        dateSent: new Date(dispatch.createdAtMs),
        edited: false,
      },
      raw: {
        channel: dispatch.destination.channelId,
        team: dispatch.destination.teamId,
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
    await options.replyToThread(thread, message, {
      ack: hooks.ack,
      conversationId,
      destination: dispatch.destination,
      execution: {
        authorizationFlowMode: "disabled",
        channelConfiguration: options.getChannelConfiguration(
          dispatch.destination.channelId,
        ),
        credentialContext: routing.credentialContext,
        destinationVisibility: dispatch.destinationVisibility,
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
      skipBackfill: true,
    });
    return {
      ...(errorMessage ? { errorMessage } : {}),
      ...(outcome ? { outcome } : {}),
      ...(resultMessageTs ? { resultMessageTs } : {}),
    };
  };
}
