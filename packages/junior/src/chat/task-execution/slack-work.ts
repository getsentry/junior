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
import { rehydrateAttachmentFetchers } from "@/chat/queue/thread-message-dispatcher";
import { getAwaitingTurnContinuationRequest } from "@/chat/services/timeout-resume";
import { resumeTimedOutTurnWithLockRetry } from "@/chat/runtime/timeout-resume-runner";
import {
  failAgentTurnSessionRecord,
  listAgentTurnSessionSummariesForConversation,
  type AgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { getStateAdapter } from "@/chat/state/adapter";
import type {
  AgentInputMessage,
  InboundMessageRecord,
} from "@/chat/task-execution/store";
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
import {
  parseActorUserId,
  type SlackActorProfile,
} from "@/chat/services/requester-identity";

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
    userId: string,
  ) => Promise<SlackActorProfile | null | undefined>;
  resumeAwaitingContinuation?: (conversationId: string) => Promise<boolean>;
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

function isSlackMetadata(
  value: AgentInputMessage["metadata"],
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
  left: InboundMessageRecord,
  right: InboundMessageRecord,
): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

function routeForRecords(
  records: InboundMessageRecord[],
): SlackConversationRoute {
  return records.some((record) => record.input.metadata?.route === "mention")
    ? "mention"
    : "subscribed";
}

function restoreMessage(args: {
  adapter: SlackAdapter;
  record: InboundMessageRecord;
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
    userId: string,
  ) => Promise<SlackActorProfile | null | undefined>;
  messages: Message[];
}): Promise<void> {
  const byAuthorId = new Map<string, Message[]>();
  for (const message of args.messages) {
    const authorId = requireSlackAuthorId(message);
    byAuthorId.set(authorId, [...(byAuthorId.get(authorId) ?? []), message]);
  }

  await Promise.all(
    [...byAuthorId].map(async ([authorId, messages]) => {
      const profile = await args.lookupSlackUser(authorId);
      await Promise.all(
        messages.map((message) =>
          ensureSlackMessageActorIdentity(message, async () => profile),
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

function isContinuationResume(summary: AgentTurnSessionSummary): boolean {
  return (
    summary.state === "awaiting_resume" &&
    (summary.resumeReason === "timeout" || summary.resumeReason === "yield")
  );
}

async function failUnresumableContinuation(args: {
  conversationId: string;
  errorMessage: string;
  expectedVersion?: number;
  summary: AgentTurnSessionSummary;
}): Promise<void> {
  await failAgentTurnSessionRecord({
    conversationId: args.conversationId,
    expectedVersion: args.expectedVersion ?? args.summary.version,
    sessionId: args.summary.sessionId,
    errorMessage: args.errorMessage,
  });
}

async function resumeAwaitingContinuation(
  conversationId: string,
): Promise<boolean> {
  const summaries =
    await listAgentTurnSessionSummariesForConversation(conversationId);

  for (const summary of summaries) {
    if (!isContinuationResume(summary)) {
      continue;
    }

    const request = await getAwaitingTurnContinuationRequest({
      conversationId,
      sessionId: summary.sessionId,
    });
    if (!request) {
      await failUnresumableContinuation({
        conversationId,
        summary,
        errorMessage:
          "Awaiting turn continuation metadata could not be materialized",
      });
      continue;
    }

    if (await resumeTimedOutTurnWithLockRetry(request)) {
      return true;
    }

    await failUnresumableContinuation({
      conversationId,
      expectedVersion: request.expectedVersion,
      summary,
      errorMessage: "Awaiting turn continuation was stale before resuming",
    });
  }

  return false;
}

function getInstallation(
  records: InboundMessageRecord[],
): SlackInstallationContext {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const metadata = records[index]?.input.metadata;
    if (isSlackMetadata(metadata) && metadata.installation) {
      return metadata.installation;
    }
  }
  return {};
}

function getPendingRecords(
  work: { messages: InboundMessageRecord[] } | undefined,
): InboundMessageRecord[] {
  if (!work) {
    return [];
  }
  return work.messages
    .filter((message) => message.injectedAtMs === undefined)
    .sort(compareInboundMessages);
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

    const resumeContinuation =
      options.resumeAwaitingContinuation ?? resumeAwaitingContinuation;
    if (await resumeContinuation(context.conversationId)) {
      return { status: "completed" };
    }

    const records = getPendingRecords(
      await getConversationWorkState({
        conversationId: context.conversationId,
        state,
      }),
    );
    if (records.length === 0) {
      await resumeContinuation(context.conversationId);
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
              messageContext,
              drainSteeringMessages,
              onInputCommitted,
              shouldYield: context.shouldYield,
            });
            return;
          }

          await options.runtime.handleSubscribedMessage(thread, latestMessage, {
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
}): InboundMessageRecord {
  const authorId = requireSlackAuthorId(args.message);
  return {
    conversationId: args.conversationId,
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
