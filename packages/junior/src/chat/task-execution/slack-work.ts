import type { SlackAdapter } from "@chat-adapter/slack";
import {
  Message,
  ThreadImpl,
  type MessageContext,
  type SerializedMessage,
  type SerializedThread,
  type StateAdapter,
} from "chat";
import type { SlackTurnRuntime } from "@/chat/runtime/slack-runtime";
import {
  isCooperativeTurnYieldError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { normalizeIncomingSlackThreadId } from "@/chat/ingress/message-router";
import { rehydrateAttachmentFetchers } from "@/chat/slack/attachment-fetchers";
import { getStateAdapter } from "@/chat/state/adapter";
import type { AgentInput, InboundMessage } from "@/chat/task-execution/store";
import {
  getConversationWorkState,
  markConversationMessagesInjected,
} from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  runWithSlackInstallation,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import { ensureSlackMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { lookupSlackUser } from "@/chat/slack/user";
import { parseActorUserId, type SlackRequesterProfile } from "@/chat/requester";
import { createSlackDestination } from "@/chat/destination";

export type SlackConversationRoute = "mention" | "subscribed";

export interface SlackConversationMessageMetadata {
  [key: string]: unknown;
  installation?: SlackInstallationContext;
  message: SerializedMessage;
  platform: "slack";
  route: SlackConversationRoute;
  thread: SerializedThread;
}

export interface CreateSlackConversationWorkerOptions {
  getSlackAdapter: () => SlackAdapter;
  lookupSlackUser?: (
    teamId: string,
    userId: string,
  ) => Promise<SlackRequesterProfile | null | undefined>;
  resumeAwaitingContinuation: (conversationId: string) => Promise<boolean>;
  runtime: Pick<
    SlackTurnRuntime<unknown>,
    "handleNewMention" | "handleSubscribedMessage"
  >;
  state?: StateAdapter;
}

function requireSlackAuthorId(message: Message): string {
  const authorId = parseActorUserId(message.author.userId);
  if (!authorId) {
    throw new Error("Slack message requires an actor user id");
  }
  return authorId;
}

function getConnectedState(stateAdapter?: StateAdapter): StateAdapter {
  return stateAdapter ?? getStateAdapter();
}

/** Validate the serialized Slack message/thread envelope stored in the mailbox. */
function isSlackMetadata(
  value: AgentInput["metadata"],
): value is SlackConversationMessageMetadata {
  return (
    Boolean(value) &&
    value?.platform === "slack" &&
    (value.route === "mention" || value.route === "subscribed") &&
    Boolean(value.thread) &&
    Boolean(value.message)
  );
}

function compareInboundMessages(
  left: InboundMessage,
  right: InboundMessage,
): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

function routeForRecords(records: InboundMessage[]): SlackConversationRoute {
  return records.some((record) => record.input.metadata?.route === "mention")
    ? "mention"
    : "subscribed";
}

/** Rehydrate the Slack message payload before handing it back to runtime code. */
function restoreMessage(args: {
  adapter: SlackAdapter;
  record: InboundMessage;
}): Message {
  const metadata = args.record.input.metadata;
  if (!isSlackMetadata(metadata)) {
    throw new Error("Conversation mailbox record is not a Slack message");
  }

  const message = Message.fromJSON(metadata.message);
  message.attachments = message.attachments.map((attachment) =>
    args.adapter.rehydrateAttachment(attachment),
  );
  rehydrateAttachmentFetchers(message);
  return message;
}

async function bindSlackActorIdentities(args: {
  lookupSlackUser: (
    teamId: string,
    userId: string,
  ) => Promise<SlackRequesterProfile | null | undefined>;
  messages: Message[];
  teamId: string;
}): Promise<void> {
  const byAuthorId = new Map<string, Message[]>();
  for (const message of args.messages) {
    const authorId = requireSlackAuthorId(message);
    byAuthorId.set(authorId, [...(byAuthorId.get(authorId) ?? []), message]);
  }

  await Promise.all(
    [...byAuthorId].map(async ([authorId, messages]) => {
      const profile = await args.lookupSlackUser(args.teamId, authorId);
      await Promise.all(
        messages.map((message) =>
          ensureSlackMessageActorIdentity(
            message,
            args.teamId,
            async () => profile,
          ),
        ),
      );
    }),
  );
}

function restoreThread(args: {
  adapter: SlackAdapter;
  isSubscribedContext: boolean;
  message: Message;
  state: StateAdapter;
  threadJson: SerializedThread;
}): ThreadImpl {
  const threadId = normalizeIncomingSlackThreadId(
    args.threadJson.id,
    args.message,
  );
  if (args.message.threadId !== threadId) {
    (args.message as unknown as { threadId: string }).threadId = threadId;
  }
  return new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: threadId,
    channelId: args.threadJson.channelId,
    channelVisibility: args.threadJson.channelVisibility,
    currentMessage: args.message,
    initialMessage: args.message,
    isDM: args.threadJson.isDM,
    isSubscribedContext: args.isSubscribedContext,
  });
}

function getInstallation(records: InboundMessage[]): SlackInstallationContext {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const metadata = records[index]?.input.metadata;
    if (isSlackMetadata(metadata) && metadata.installation) {
      return metadata.installation;
    }
  }
  return {};
}

function getPendingRecords(
  work: { execution: { pendingMessages: InboundMessage[] } } | undefined,
): InboundMessage[] {
  if (!work) {
    return [];
  }
  return work.execution.pendingMessages.sort(compareInboundMessages);
}

/** Build the worker run function for queued Slack conversation work. */
export function createSlackConversationWorker(
  options: CreateSlackConversationWorkerOptions,
): (context: ConversationWorkerContext) => Promise<ConversationWorkerResult> {
  return async (context) => {
    const adapter = options.getSlackAdapter();
    const actorLookup = options.lookupSlackUser ?? lookupSlackUser;
    const state = getConnectedState(options.state);
    await state.connect();

    const records = getPendingRecords(
      await getConversationWorkState({
        conversationId: context.conversationId,
        state,
      }),
    );
    if (records.length === 0) {
      await options.resumeAwaitingContinuation(context.conversationId);
      return { status: "completed" };
    }

    const latestRecord = records[records.length - 1];
    if (!latestRecord) {
      return { status: "completed" };
    }

    const latestMetadata = latestRecord.input.metadata;
    if (!isSlackMetadata(latestMetadata)) {
      throw new Error(
        "Latest conversation mailbox record is not Slack metadata",
      );
    }

    if (!(await context.checkIn())) {
      return { status: "lost_lease" };
    }

    const turnResult = await runWithSlackInstallation({
      adapter,
      installation: getInstallation(records),
      state,
      task: async () => {
        const messages = records.map((record) =>
          restoreMessage({ adapter, record }),
        );
        await bindSlackActorIdentities({
          lookupSlackUser: actorLookup,
          messages,
          teamId: context.destination.teamId,
        });
        const latestMessage = messages[messages.length - 1];
        if (!latestMessage) {
          return;
        }
        const route = routeForRecords(records);
        const thread = restoreThread({
          adapter,
          isSubscribedContext: route === "subscribed",
          message: latestMessage,
          state,
          threadJson: latestMetadata.thread,
        });
        const skipped = messages.slice(0, -1);
        const messageContext: MessageContext = {
          skipped,
          totalSinceLastHandler: messages.length,
        };
        const initialInboundMessageIds = records.map(
          (record) => record.inboundMessageId,
        );
        let initialMessagesPersisted = false;
        const markInitialMessagesInjected = async (): Promise<boolean> => {
          if (initialMessagesPersisted) {
            return true;
          }
          const marked = await markConversationMessagesInjected({
            conversationId: context.conversationId,
            inboundMessageIds: initialInboundMessageIds,
            leaseToken: context.leaseToken,
            state,
          });
          initialMessagesPersisted = marked;
          return marked;
        };
        const onInputCommitted = async (): Promise<void> => {
          if (!(await markInitialMessagesInjected())) {
            throw new TurnInputCommitLostError(
              `Conversation work lease lost before Slack input commit for ${context.conversationId}`,
            );
          }
        };
        const drainSteeringMessages = async (
          inject: (messages: Message[]) => Promise<void>,
        ): Promise<Message[]> => {
          let restoredMessages: Message[] | undefined;
          const drained = await context.drainMailbox(async (pendingRecords) => {
            const messages = pendingRecords.map((record) =>
              restoreMessage({ adapter, record }),
            );
            restoredMessages = messages;
            await inject(messages);
          });
          return (
            restoredMessages ??
            drained.map((record) => restoreMessage({ adapter, record }))
          );
        };

        try {
          if (route === "mention") {
            await options.runtime.handleNewMention(thread, latestMessage, {
              destination: context.destination,
              messageContext,
              drainSteeringMessages,
              onInputCommitted,
              shouldYield: context.shouldYield,
            });
            return;
          }

          await options.runtime.handleSubscribedMessage(thread, latestMessage, {
            destination: context.destination,
            messageContext,
            drainSteeringMessages,
            onInputCommitted,
            shouldYield: context.shouldYield,
          });
        } catch (error) {
          if (isCooperativeTurnYieldError(error)) {
            return { status: "yielded" } satisfies ConversationWorkerResult;
          }
          if (isTurnInputCommitLostError(error)) {
            return { status: "lost_lease" } satisfies ConversationWorkerResult;
          }
          throw error;
        }
      },
    });
    if (
      turnResult?.status === "yielded" ||
      turnResult?.status === "lost_lease"
    ) {
      return turnResult;
    }

    return { status: "completed" };
  };
}

/** Serialize a Slack message into the generic durable conversation mailbox. */
export function buildSlackInboundMessage(args: {
  conversationId: string;
  installation?: SlackInstallationContext;
  message: Message;
  receivedAtMs: number;
  route: SlackConversationRoute;
  thread: ThreadImpl;
}): InboundMessage {
  const authorId = requireSlackAuthorId(args.message);
  const destination = createSlackDestination({
    channelId: args.thread.channelId,
    teamId: args.installation?.teamId,
  });
  if (!destination) {
    throw new Error("Slack inbound message requires destination context");
  }
  return {
    conversationId: args.conversationId,
    destination,
    inboundMessageId: [
      "slack",
      args.installation?.teamId ?? args.installation?.enterpriseId ?? "unknown",
      args.conversationId,
      args.message.id,
    ].join(":"),
    source: "slack",
    createdAtMs: args.message.metadata.dateSent.getTime(),
    receivedAtMs: args.receivedAtMs,
    input: {
      text: args.message.text || " ",
      authorId,
      attachments: args.message.attachments,
      metadata: {
        platform: "slack",
        route: args.route,
        installation: args.installation,
        thread: args.thread.toJSON(),
        message: args.message.toJSON(),
      } satisfies SlackConversationMessageMetadata,
    },
  };
}
