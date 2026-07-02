import type { SlackAdapter } from "@chat-adapter/slack";
import {
  Message,
  ThreadImpl,
  type MessageContext,
  type SerializedMessage,
  type SerializedThread,
  type StateAdapter,
} from "chat";
import type {
  SlackTurnOptions,
  SteeringCandidateMessage,
} from "@/chat/runtime/slack-runtime";
import {
  isCooperativeTurnYieldError,
  isTurnInputDeferredError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { normalizeIncomingSlackThreadId } from "@/chat/ingress/message-router";
import { rehydrateAttachmentFetchers } from "@/chat/slack/attachment-fetchers";
import { getStateAdapter } from "@/chat/state/adapter";
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentInput, InboundMessage } from "@/chat/task-execution/store";
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
import {
  createSlackDestination,
  requireSlackDestination,
} from "@/chat/destination";

export type SlackConversationRoute = "mention" | "subscribed";

export interface SlackConversationMessageMetadata {
  [key: string]: unknown;
  installation?: SlackInstallationContext;
  message: SerializedMessage;
  platform: "slack";
  route: SlackConversationRoute;
  thread: SerializedThread;
}

type SlackInboxTurnOptions = SlackTurnOptions & {
  ack: () => Promise<void>;
  isFinalAttempt: boolean;
};

interface SlackInboxTurnRuntime {
  handleNewMention(
    thread: ThreadImpl,
    message: Message,
    hooks: SlackInboxTurnOptions,
  ): Promise<void>;
  handleSubscribedMessage(
    thread: ThreadImpl,
    message: Message,
    hooks: SlackInboxTurnOptions,
  ): Promise<void>;
}

interface SlackResourceEventInboundInput {
  event: {
    eventKey: string;
    eventType: string;
    occurredAtMs: number;
    provider: string;
    resourceRef: string;
  };
  subscription: {
    conversationId: string;
    destination: {
      channelId: string;
      platform: "slack";
      teamId: string;
    };
    id: string;
  };
  text: string;
}

export interface CreateSlackConversationWorkerOptions {
  getSlackAdapter: () => SlackAdapter;
  lookupSlackUser?: (
    teamId: string,
    userId: string,
  ) => Promise<SlackRequesterProfile | null | undefined>;
  resumeAwaitingContinuation: (conversationId: string) => Promise<boolean>;
  conversationStore?: ConversationStore;
  runtime: SlackInboxTurnRuntime;
  state?: StateAdapter;
}

function requireSlackAuthorId(message: Message): string {
  const authorId = parseActorUserId(message.author.userId);
  if (!authorId) {
    throw new Error("Slack message requires an actor user id");
  }
  return authorId;
}

function parseSlackConversationId(
  conversationId: string,
): { channelId: string; threadTs: string } | undefined {
  const parts = conversationId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack" || !parts[1] || !parts[2]) {
    return undefined;
  }
  return { channelId: parts[1], threadTs: parts[2] };
}

function slackSerializedThread(input: {
  channelId: string;
  message: SerializedMessage;
  threadTs: string;
}): SerializedThread {
  return {
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: input.channelId,
    currentMessage: input.message,
    id: `slack:${input.channelId}:${input.threadTs}`,
    isDM: input.channelId.startsWith("D"),
  };
}

/**
 * Serialize a synthetic resource-event mailbox message without a native Slack
 * message timestamp so Slack Web API calls cannot target the internal id.
 */
function slackSerializedResourceEventMessage(input: {
  channelId: string;
  id: string;
  text: string;
  threadTs: string;
  timestampIso: string;
}): SerializedMessage {
  return {
    _type: "chat:Message",
    attachments: [],
    author: {
      userId: "UJRNEVENT",
      userName: "junior-event",
      fullName: "Junior event",
      isBot: true,
      isMe: false,
    },
    formatted: { type: "root", children: [] },
    id: input.id,
    metadata: {
      dateSent: input.timestampIso,
      edited: false,
    },
    raw: {
      channel: input.channelId,
      event_type: "resource_event",
      thread_ts: input.threadTs,
      type: "message",
      user: "UJRNEVENT",
    },
    text: input.text,
    threadId: `slack:${input.channelId}:${input.threadTs}`,
  };
}

/** Create a Slack mailbox record for a subscribed resource-event notification. */
export function createSlackResourceEventInboundMessage(
  input: SlackResourceEventInboundInput,
): InboundMessage {
  const slack = parseSlackConversationId(input.subscription.conversationId);
  if (!slack) {
    throw new Error(
      "Resource event delivery currently requires a Slack conversation",
    );
  }
  const destination = input.subscription.destination;
  if (destination.channelId !== slack.channelId) {
    throw new Error(
      "Resource event subscription destination does not match Slack conversation",
    );
  }
  const messageId = `resource-event-${input.subscription.id}-${input.event.eventKey}`;
  const timestampIso = new Date(input.event.occurredAtMs).toISOString();
  const message = slackSerializedResourceEventMessage({
    channelId: slack.channelId,
    id: messageId,
    text: input.text,
    threadTs: slack.threadTs,
    timestampIso,
  });
  const thread = slackSerializedThread({
    channelId: slack.channelId,
    message,
    threadTs: slack.threadTs,
  });
  return {
    conversationId: input.subscription.conversationId,
    createdAtMs: input.event.occurredAtMs,
    destination,
    inboundMessageId: `resource-event:${input.subscription.id}:${input.event.eventKey}`,
    source: "resource_event",
    receivedAtMs: Date.now(),
    input: {
      text: input.text,
      authorId: "UJRNEVENT",
      metadata: {
        kind: "resource_event",
        installation: {
          teamId: destination.teamId,
        },
        platform: "slack",
        route: "subscribed",
        thread,
        message,
        resourceEvent: {
          eventKey: input.event.eventKey,
          eventType: input.event.eventType,
          provider: input.event.provider,
          resourceRef: input.event.resourceRef,
          subscriptionId: input.subscription.id,
        },
      } satisfies SlackConversationMessageMetadata & {
        kind: "resource_event";
        resourceEvent: Record<string, string>;
      },
    },
  };
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
  return records.some((record) => {
    const metadata = record.input.metadata;
    if (!isSlackMetadata(metadata)) {
      throw new Error("Conversation mailbox record is not Slack metadata");
    }
    return metadata.route === "mention";
  })
    ? "mention"
    : "subscribed";
}

function isSlackAssistantThreadUserMessage(message: Message): boolean {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return (
    raw?.channel_type === "im" &&
    typeof raw.thread_ts === "string" &&
    raw.thread_ts.trim().length > 0
  );
}

function isResourceEventNotificationMessage(message: Message): boolean {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return raw?.event_type === "resource_event";
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
    if (isResourceEventNotificationMessage(message)) {
      continue;
    }
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

    const records = getPendingRecords({
      execution: { pendingMessages: [...context.attempt.messages] },
    });
    if (records.length === 0) {
      const destination = requireSlackDestination(
        context.destination,
        "Slack continuation recovery",
      );
      await runWithSlackInstallation({
        adapter,
        installation: { teamId: destination.teamId },
        state,
        task: async () => {
          await options.resumeAwaitingContinuation(context.conversationId);
        },
      });
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
        const destination = requireSlackDestination(
          context.destination,
          "Slack conversation work",
        );
        await bindSlackActorIdentities({
          lookupSlackUser: actorLookup,
          messages,
          teamId: destination.teamId,
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
        let initialMessagesAcked = false;
        const ack = async (): Promise<void> => {
          if (initialMessagesAcked) {
            return;
          }
          try {
            await context.attempt.ack();
            initialMessagesAcked = true;
          } catch {
            throw new TurnInputCommitLostError(
              `Conversation work lease lost before Slack inbox ack for ${context.conversationId}`,
            );
          }
        };
        // Restore stored mailbox entries as Slack steering candidates; the
        // runtime returns only the inbound ids it handled durably.
        const drainSteeringMessages = async (
          accept: (
            messages: SteeringCandidateMessage[],
          ) => Promise<readonly string[] | void>,
        ): Promise<void> => {
          await context.attempt.drain(async (pendingRecords) => {
            const messages = pendingRecords.map((record) => {
              const metadata = record.input.metadata;
              if (!isSlackMetadata(metadata)) {
                throw new Error(
                  "Conversation mailbox record is not Slack metadata",
                );
              }
              const message = restoreMessage({ adapter, record });
              return {
                activeRequest:
                  metadata.route === "mention" ||
                  isSlackAssistantThreadUserMessage(message),
                inboundMessageId: record.inboundMessageId,
                message,
              };
            });
            return await accept(messages);
          });
        };

        try {
          if (route === "mention") {
            await options.runtime.handleNewMention(thread, latestMessage, {
              destination: context.destination,
              messageContext,
              drainSteeringMessages,
              ack,
              isFinalAttempt: context.attempt.isFinalAttempt,
              shouldYield: context.shouldYield,
            });
            return;
          }

          await options.runtime.handleSubscribedMessage(thread, latestMessage, {
            destination: context.destination,
            messageContext,
            drainSteeringMessages,
            ack,
            isFinalAttempt: context.attempt.isFinalAttempt,
            shouldYield: context.shouldYield,
          });
        } catch (error) {
          if (isTurnInputDeferredError(error)) {
            return { status: "deferred" } satisfies ConversationWorkerResult;
          }
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
      turnResult?.status === "deferred" ||
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
