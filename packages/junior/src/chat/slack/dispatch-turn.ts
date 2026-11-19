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

type ExecuteSlackTurn = (
  thread: ThreadImpl,
  message: Message,
  options: {
    ack?: () => Promise<void>;
    conversationId: string;
    destination: DispatchRecord["destination"];
    execution: DispatchTurnContext;
    onTurnDeliveryAccepted?: (messageId?: string) => void;
    onTurnOutcome?: (result: DispatchTurnResult) => void;
    shouldYield?: (() => boolean) | undefined;
    checkIn?: (() => Promise<boolean>) | undefined;
    skipBackfill?: boolean;
  },
) => Promise<void>;

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
  ): Promise<DispatchTurnResult | undefined> {
    const state = getStateAdapter();
    await state.connect();
    const conversationId = getDispatchConversationId(dispatch);
    const adapter = options.getSlackAdapter();
    // Thread.id is the Slack thread on every path. A top-level post has no
    // thread yet, so it gets the channel-level id.
    const slackThreadId = adapter.encodeThreadId({
      channel: dispatch.destination.channelId,
      threadTs: dispatch.destination.threadTs ?? "",
    });
    // TODO(dcramer): Remove this synthetic Slack Message and Thread after
    // dispatch work supplies Slack Delivery to the shared Turn path.
    const message = new Message({
      id: getDispatchInputMessageId(dispatch.id),
      threadId: slackThreadId,
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
        ...(dispatch.destination.threadTs
          ? { thread_ts: dispatch.destination.threadTs }
          : undefined),
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
      id: slackThreadId,
      channelId: dispatch.destination.channelId,
      channelVisibility:
        dispatch.destinationVisibility === "public" ? "workspace" : "private",
      currentMessage: message,
      initialMessage: message,
      isDM: dispatch.destination.channelId.startsWith("D"),
      isSubscribedContext: true,
    });

    let outcome: DispatchTurnResult | undefined;
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
        outcome = result;
      },
      shouldYield: hooks.shouldYield,
      checkIn: hooks.checkIn,
      skipBackfill: true,
    });
    // Without a reported outcome, the dispatch worker reads the turn record.
    if (
      resultMessageTs &&
      (outcome?.outcome === "blocked" ||
        outcome?.outcome === "completed" ||
        outcome?.outcome === "failed")
    ) {
      return { ...outcome, resultMessageTs };
    }
    return outcome;
  };
}
