import { presentSlackAnnotationDetails } from "@/chat/slack/annotation-details";
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  slackAssistantThreadSchema,
  slackEventEnvelopeSchema,
  type SlackEventEnvelope,
  type SlackInboundEvent,
} from "./slack-payload";
import { handleSlackForm } from "./slack-form";
import { ThreadImpl, type Message, type StateAdapter } from "chat";
import type { SlackTurnRuntime } from "@/chat/providers/slack/runtime";
import { THREAD_OPTOUT_ACK } from "@/chat/providers/slack/runtime";
import {
  startProcessingReaction,
  type ProcessingReaction,
} from "@/chat/providers/slack/processing-reaction";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { appendConversationMessages } from "@/chat/conversations/messages";
import { stopConversationTurn } from "@/chat/conversations/stop";
import { stopConversationSession } from "@/chat/agent-invocations/stop";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { withLock } from "@/chat/state/locks";
import {
  buildSlackInboundMessage,
  clearSlackPendingReactions,
  type SlackConversationRoute,
} from "@/chat/task-execution/slack-work";
import {
  runWithSlackInstallation,
  verifySlackSignature,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import { textMentionsBot } from "@/chat/ingress/bot-mention";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import {
  SLACK_EVENT_NAMESPACE,
  slackChannelMessageEvent,
} from "@/chat/slack/channel-message-events";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { botConfig } from "@/chat/config";
import { recordSkippedConversationMessage } from "@/chat/runtime/conversation-message";
import {
  getThreadStopDecision,
  SubscribedReplyReason,
} from "@/chat/services/subscribed-decision";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { parseContent } from "@/chat/slack/message/content";
import {
  isSlackMessageStopped,
  stopSlackThread,
} from "@/chat/slack/thread-stop";
import {
  normalizeIncomingSlackThreadId,
  withNormalizedThreadId,
} from "@/chat/ingress/message-router";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { isSlackAuthorDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { slackMessageAttributes } from "./slack-message-telemetry";
import { slackMention } from "@/chat/slack/mrkdwn";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import { getStateAdapter } from "@/chat/state/adapter";
import { persistSlackUserInputReply } from "@/chat/slack/user-input-state";
import { slackUserInputAnswerNote } from "@/chat/slack/user-input";
import { SlackEventPersistenceError } from "./slack-event-persistence-error";
import { parseActorUserId } from "@/chat/actor";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { presentSlackAutomationDetails } from "@/chat/slack/automation-details";
import { getSlackClient } from "@/chat/slack/client";
import { createSlackWebApiStatusSender } from "@/chat/slack/assistant-thread/status-send";
import {
  logException,
  setSpanAttributes,
  withLogContext,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

function slackEventLogContext(
  event: SlackInboundEvent | undefined,
): LogContext {
  const channelId = event?.channel?.trim() || undefined;
  const threadTs = event?.thread_ts?.trim() || event?.ts?.trim() || undefined;
  const conversationId =
    channelId && threadTs ? `slack:${channelId}:${threadTs}` : undefined;
  return {
    platform: "slack",
    conversationId,
    messageConversationId: conversationId,
    destinationName: channelId,
    userId: event?.user?.trim() || undefined,
  };
}

const IGNORED_MESSAGE_SUBTYPES = new Set([
  // Conversation Messages are immutable once accepted. An edit must not
  // rewrite input or start another Turn. Send a new Slack Message instead.
  "message_changed",
  "message_deleted",
  "message_replied",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "ekm_access_denied",
  "tombstone",
]);

export interface SlackWebhookServices {
  getUserTokenStore?: () => UserTokenStore;
  getSlackAdapter: () => SlackAdapter;
  queue: ConversationWorkQueue;
  conversationStore?: ConversationStore;
  /** Email domains Slack authors need to start a Turn. Empty allows all. */
  allowedDomains?: readonly string[];
  /** Slack user IDs of bots that may start a Turn without an email domain. */
  allowedBotUserIds?: readonly string[];
  runtime: Pick<
    SlackTurnRuntime<unknown>,
    | "handleAssistantContextChanged"
    | "handleAssistantThreadStarted"
    | "handleNewMention"
    | "handleSubscribedMessage"
  >;
  state?: StateAdapter;
}

function enqueue(waitUntil: WaitUntilFn, task: Promise<void>): void {
  waitUntil(task);
}

function getUserTokenStore(services: SlackWebhookServices): UserTokenStore {
  return services.getUserTokenStore?.() ?? createUserTokenStore();
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function installationFromEnvelope(
  body: SlackEventEnvelope,
): SlackInstallationContext {
  return {
    teamId: body.team_id,
    enterpriseId: body.enterprise_id,
    isEnterpriseInstall: body.is_enterprise_install === true,
  };
}

function isDmEvent(event: SlackInboundEvent): boolean {
  return event.channel_type === "im" || event.channel?.startsWith("D") === true;
}

function shouldIgnoreMessageSubtype(event: SlackInboundEvent): boolean {
  return Boolean(event.subtype && IGNORED_MESSAGE_SUBTYPES.has(event.subtype));
}

function normalizeMessageThreadId(message: Message): {
  message: Message;
  threadId: string;
} {
  const threadId = normalizeIncomingSlackThreadId(message.threadId, message);
  return {
    message: withNormalizedThreadId(message, threadId),
    threadId,
  };
}

async function buildThread(args: {
  adapter: SlackAdapter;
  message: Message;
  route: SlackConversationRoute;
  state: StateAdapter;
}): Promise<ThreadImpl> {
  const normalized = normalizeMessageThreadId(args.message);
  return new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: normalized.threadId,
    channelId: args.adapter.channelIdFromThreadId(normalized.threadId),
    channelVisibility: args.adapter.getChannelVisibility(normalized.threadId),
    currentMessage: normalized.message,
    initialMessage: normalized.message,
    isDM: args.adapter.isDM(normalized.threadId),
    isSubscribedContext: args.route === "subscribed",
  });
}

function shouldIgnoreMessage(message: Message): boolean {
  return (
    message.author.isMe === true || !parseActorUserId(message.author.userId)
  );
}

function shouldPersistBeforeAck(body: SlackEventEnvelope): boolean {
  return body.event?.type === "app_mention" || body.event?.type === "message";
}

async function resolveSlackConversationId(args: {
  canonicalThreadId: string;
  conversationStore?: ConversationStore;
  installation: SlackInstallationContext;
}): Promise<string> {
  const providerThread = parseSlackThreadId(args.canonicalThreadId);
  const conversationStore = args.conversationStore ?? getConversationStore();
  if (!providerThread) {
    return args.canonicalThreadId;
  }
  return (
    (await conversationStore.getConversationIdByProviderConversation({
      provider: "slack",
      providerDestinationId: providerThread.channelId,
      providerTenantId: args.installation.teamId ?? "",
      providerConversationId: providerThread.threadTs,
    })) ?? args.canonicalThreadId
  );
}

async function persistSlackMessage(args: {
  adapter: SlackAdapter;
  installation: SlackInstallationContext;
  message: Message;
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue;
  receivedAtMs: number;
  route: SlackConversationRoute;
  state: StateAdapter;
  conversationId?: string;
}): Promise<void> {
  const canonicalThreadId = normalizeIncomingSlackThreadId(
    args.message.threadId,
    args.message,
  );
  const conversationId =
    args.conversationId ??
    (await resolveSlackConversationId({
      canonicalThreadId,
      conversationStore: args.conversationStore,
      installation: args.installation,
    }));
  const thread = await buildThread(args);
  const inbound = buildSlackInboundMessage({
    conversationId,
    installation: args.installation,
    message: args.message,
    receivedAtMs: args.receivedAtMs,
    route: args.route,
    thread,
  });
  const work = await getConversationWorkState({
    conversationId,
    state: args.state,
  });
  let receipt: ProcessingReaction | undefined;
  if (
    args.route === "mention" &&
    !work?.execution.inboundMessageIds.includes(inbound.inboundMessageId) &&
    !(await isSlackMessageStopped({
      messageCreatedAtMs: args.message.metadata.dateSent.getTime(),
      state: args.state,
      threadId: canonicalThreadId,
    }))
  ) {
    // Ingress is serialized per thread. React before publishing new input so
    // neither a fast worker nor a duplicate delivery can leave a stale reaction.
    receipt = await startProcessingReaction({
      message: args.message,
      thread,
      timeoutMs: 1_000,
    });
  }
  await appendAndEnqueueInboundMessage({
    message: inbound,
    conversationStore: args.conversationStore,
    queue: args.queue,
    state: args.state,
  }).catch(async (error: unknown) => {
    // A failed queue send can follow a successful append. Keep that receipt:
    // retries or heartbeat recovery can still process the saved input.
    const saved = await getConversationWorkState({
      conversationId,
      state: args.state,
    });
    const kept =
      saved?.execution.inboundMessageIds.includes(inbound.inboundMessageId) ===
      true;
    if (!kept) {
      await receipt?.stop();
    }
    throw new SlackEventPersistenceError(error, kept);
  });
}

/**
 * Interrupt the active Run, stop the session, unsubscribe, and record
 * the stop message in history. Stop input never enters the mailbox, so a
 * mention-route stop cannot resubscribe the thread by starting a new Turn.
 *
 * A late or stale stop that a newer mention already superseded is a no-op:
 * cancelling the Turn or posting the ack here would clobber that mention.
 */
async function handleSlackThreadStop(args: {
  adapter: SlackAdapter;
  canonicalThreadId: string;
  conversationStore?: ConversationStore;
  installation: SlackInstallationContext;
  message: Message;
  queue: ConversationWorkQueue;
  route: SlackConversationRoute;
  state: StateAdapter;
  stopReason: string;
}): Promise<void> {
  const thread = await buildThread(args);
  const conversationId = await resolveSlackConversationId({
    canonicalThreadId: args.canonicalThreadId,
    conversationStore: args.conversationStore,
    installation: args.installation,
  });
  // Capture receipts before the watermark lets a worker discard stale input.
  // The ingress lock prevents another Slack message from arriving meanwhile.
  const work = await getConversationWorkState({
    conversationId,
    state: args.state,
  });
  const { applied } = await stopSlackThread({
    state: args.state,
    stoppedAtMs: args.message.metadata.dateSent.getTime(),
    thread,
  });
  if (!applied) {
    return;
  }

  await stopConversationTurn({
    conversationId,
    conversationStore: args.conversationStore,
    queue: args.queue,
    state: args.state,
  });
  await clearSlackPendingReactions({
    getSlackAdapter: () => args.adapter,
    messages: work?.execution.pendingMessages ?? [],
    state: args.state,
  });
  await stopConversationSession({ conversationId, state: args.state });

  const content = parseContent(args.message);
  const conversation = coerceThreadConversationState(undefined);
  recordSkippedConversationMessage({
    conversation,
    message: args.message,
    skippedReason: `${SubscribedReplyReason.ThreadOptOut}:${args.stopReason}`,
    text: content.text,
  });
  await appendConversationMessages(getConversationEventStore(), {
    conversation,
    conversationId,
  });

  await thread.post(THREAD_OPTOUT_ACK);
}

/** Acknowledge a native Slack stop that interrupted active work. */
export const SLACK_SESSION_STOP_ACK = "Stopped.";

/**
 * Stop the active Turn when a user clicks Slack's native agent stop button.
 *
 * Unlike the `stop` keyword, this only interrupts current work. The thread
 * stays subscribed and resource watches stay active. Slack does not leave the
 * `processing` status by itself, so clear the status even when no work runs.
 * https://docs.slack.dev/reference/events/agent_session_stopped
 */
async function handleSlackSessionStop(args: {
  adapter: SlackAdapter;
  channelId: string;
  conversationStore?: ConversationStore;
  installation: SlackInstallationContext;
  queue: ConversationWorkQueue;
  state: StateAdapter;
  threadTs: string;
}): Promise<void> {
  const canonicalThreadId = `slack:${args.channelId}:${args.threadTs}`;
  const conversationId = await resolveSlackConversationId({
    canonicalThreadId,
    conversationStore: args.conversationStore,
    installation: args.installation,
  });
  const stopped = await stopConversationTurn({
    conversationId,
    conversationStore: args.conversationStore,
    queue: args.queue,
    state: args.state,
  });
  await createSlackWebApiStatusSender({
    channelId: args.channelId,
    threadTs: args.threadTs,
  })("");
  if (stopped.status !== "requested") {
    return;
  }

  await clearSlackPendingReactions({
    getSlackAdapter: () => args.adapter,
    messages: stopped.pendingMessages,
    state: args.state,
  });
  const thread = new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: canonicalThreadId,
    channelId: args.adapter.channelIdFromThreadId(canonicalThreadId),
    isDM: args.adapter.isDM(canonicalThreadId),
  });
  await thread.post(SLACK_SESSION_STOP_ACK);
}

async function routeParsedMessage(args: {
  adapter: SlackAdapter;
  event: SlackInboundEvent;
  installation: SlackInstallationContext;
  message: Message;
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue;
  receivedAtMs: number;
  allowedBotUserIds: readonly string[];
  allowedDomains: readonly string[];
  state: StateAdapter;
}): Promise<void> {
  if (shouldIgnoreMessage(args.message)) {
    return;
  }

  const normalized = normalizeMessageThreadId(args.message);
  const message = normalized.message;
  const canonicalThreadId = normalized.threadId;
  // Slack still emits app_mention for tokens inside code spans/blocks. Only
  // count mentions that sit outside code as activations.
  const botUserId = args.adapter.botUserId;
  const isMention = Boolean(
    botUserId &&
    (textMentionsBot(args.event.text ?? "", botUserId) ||
      args.event.blocks?.some(
        (block) =>
          block.type === "section" &&
          typeof block.text === "object" &&
          block.text.type === "mrkdwn" &&
          textMentionsBot(block.text.text, botUserId),
      )),
  );
  if (isMention) {
    message.isMention = true;
  }

  const isDirectMessage = isDmEvent(args.event);
  const isSubscribed =
    !isDirectMessage &&
    !isMention &&
    (await args.state.isSubscribed(canonicalThreadId));
  const route: SlackConversationRoute | undefined =
    isDirectMessage || isMention
      ? "mention"
      : isSubscribed
        ? "subscribed"
        : undefined;
  if (!route) {
    // A new top-level message can run Event automations for this channel.
    // Use only `message`: Slack also sends `app_mention` for a mention in code.
    const channelMessage =
      args.event.type === "message" && args.event.channel && args.event.ts
        ? slackChannelMessageEvent({
            botId: args.event.bot_id,
            channelId: args.event.channel,
            subtype: args.event.subtype,
            text: args.event.text,
            threadTs: args.event.thread_ts,
            ts: args.event.ts,
            userId: message.author.userId,
          })
        : undefined;
    const teamId = args.installation.teamId;
    if (channelMessage && teamId) {
      await ingestEventAutomations(
        { ...channelMessage, namespace: SLACK_EVENT_NAMESPACE },
        { queue: args.queue, teamId },
      );
    }
    return;
  }

  const stopDecision = getThreadStopDecision({
    botUserName: botConfig.userName,
    rawText: args.event.text ?? "",
    text: args.event.text ?? "",
    isExplicitMention: isMention,
  });
  if (stopDecision) {
    await handleSlackThreadStop({
      adapter: args.adapter,
      canonicalThreadId,
      conversationStore: args.conversationStore,
      installation: args.installation,
      message,
      queue: args.queue,
      route,
      state: args.state,
      stopReason: stopDecision.reasonDetail ?? stopDecision.reason,
    });
    return;
  }

  // Passive thread messages are not checked for the allowed domains yet.
  if (
    route === "mention" &&
    !(await isSlackAuthorDomainAllowed({
      allowedBotUserIds: args.allowedBotUserIds,
      allowedDomains: args.allowedDomains,
      state: args.state,
      teamId: args.installation.teamId,
      user: args.event.user,
    }))
  ) {
    return;
  }

  const conversationId = await resolveSlackConversationId({
    canonicalThreadId,
    conversationStore: args.conversationStore,
    installation: args.installation,
  });

  // Keep non-mention thread messages as Conversation history without waking a
  // worker when passive routing is off. Later explicit mentions still need them.
  // Write to the Conversation that owns the thread, which mention Turns read.
  if (isSubscribed && !isExperimentalFeatureEnabled("passive-routing")) {
    const content = parseContent(message);
    const conversation = coerceThreadConversationState(undefined);
    recordSkippedConversationMessage({
      conversation,
      message,
      skippedReason: `${SubscribedReplyReason.PassiveDisabled}:passive-routing`,
      text: content.text,
    });
    await appendConversationMessages(getConversationEventStore(), {
      conversation,
      conversationId,
    });
    return;
  }

  const persist = () =>
    persistSlackMessage({
      adapter: args.adapter,
      installation: args.installation,
      message,
      conversationId,
      conversationStore: args.conversationStore,
      queue: args.queue,
      receivedAtMs: args.receivedAtMs,
      route,
      state: args.state,
    });
  if (route !== "mention") {
    await persist();
    return;
  }
  // A message to Junior answers an open question in its thread, like a click.
  await persistSlackUserInputReply({
    channelId: args.event.channel,
    claimedBy: message.author.userId,
    isSaved: (error) =>
      error instanceof SlackEventPersistenceError && error.saved,
    note: (request) =>
      slackUserInputAnswerNote({
        request,
        who: slackMention(message.author.userId),
      }),
    persist,
    state: args.state,
    threadTs: args.event.thread_ts,
  });
}

async function handleSlackEvent(args: {
  body: SlackEventEnvelope;
  services: SlackWebhookServices;
}): Promise<void> {
  const event = args.body.event;
  if (!event) {
    return;
  }

  const adapter = args.services.getSlackAdapter();
  const state = args.services.state ?? getStateAdapter();
  await state.connect();
  const installation = installationFromEnvelope(args.body);
  const receivedAtMs = Date.now();

  async function publishAppHomeViewBestEffort(userId: string): Promise<void> {
    await withLogContext({ platform: "slack", userId }, async () => {
      try {
        await publishAppHomeView(
          getSlackClient(),
          userId,
          getUserTokenStore(args.services),
        );
      } catch (error) {
        logException(error, "slack.app_home.publish.failed");
      }
    });
  }

  await runWithWorkspaceTeamId(installation.teamId, () =>
    runWithSlackInstallation({
      adapter,
      installation,
      state,
      task: async () => {
        if (
          event.type === "assistant_thread_started" ||
          event.type === "assistant_thread_context_changed"
        ) {
          const parsed = slackAssistantThreadSchema.safeParse(
            event.assistant_thread,
          );
          if (!parsed.success) return;

          const thread = parsed.data;
          const callback = {
            channelId: thread.channel_id,
            context: { channelId: thread.context.channel_id },
            threadId: adapter.encodeThreadId({
              channel: thread.channel_id,
              threadTs: thread.thread_ts,
            }),
            threadTs: thread.thread_ts,
            userId: thread.user_id,
          };
          if (event.type === "assistant_thread_started") {
            await args.services.runtime.handleAssistantThreadStarted(callback);
          } else {
            await args.services.runtime.handleAssistantContextChanged(callback);
          }
          return;
        }

        if (event.type === "entity_details_requested") {
          const ref = event.external_ref;
          if (
            ref &&
            typeof ref === "object" &&
            "type" in ref &&
            ref.type === "annotation"
          ) {
            await presentSlackAnnotationDetails(event, installation.teamId);
          } else {
            await presentSlackAutomationDetails(event, installation.teamId);
          }
          return;
        }

        if (event.type === "app_home_opened" && event.user) {
          await publishAppHomeViewBestEffort(event.user);
          return;
        }

        if (
          event.type === "agent_session_stopped" &&
          event.channel &&
          event.thread_ts
        ) {
          if (!(await isSlackWorkspaceMember(event, state))) return;
          const channelId = event.channel;
          const threadTs = event.thread_ts;
          const routed = await withLock(
            state,
            `slack:ingress:slack:${channelId}:${threadTs}`,
            () =>
              handleSlackSessionStop({
                adapter,
                channelId,
                conversationStore: args.services.conversationStore,
                installation,
                queue: args.services.queue,
                state,
                threadTs,
              }),
            { keepAlive: true, waitMs: 10_000 },
          );
          if (!routed.acquired) {
            throw new Error("Could not acquire Slack ingress lock");
          }
          return;
        }

        if (
          (event.type === "message" || event.type === "app_mention") &&
          !shouldIgnoreMessageSubtype(event) &&
          event.channel &&
          event.ts
        ) {
          const member = await isSlackWorkspaceMember(event, state);
          setSpanAttributes({
            "app.slack.membership": member ? "verified" : "unverified",
          });
          if (!member) return;
          const message = adapter.parseMessage(event);
          const routed = await withLock(
            state,
            `slack:ingress:${normalizeMessageThreadId(message).threadId}`,
            () =>
              routeParsedMessage({
                adapter,
                event,
                installation,
                message,
                conversationStore: args.services.conversationStore,
                queue: args.services.queue,
                receivedAtMs,
                allowedBotUserIds: args.services.allowedBotUserIds ?? [],
                allowedDomains: args.services.allowedDomains ?? [],
                state,
              }),
            { keepAlive: true, waitMs: 10_000 },
          );
          if (!routed.acquired) {
            throw new Error("Could not acquire Slack ingress lock");
          }
        }
      },
    }),
  );
}

/**
 * Persist one Slack input as a mention under the thread's ingress lock.
 * Slack does not retry interactions. Saved input still runs through heartbeat
 * recovery, so a failed queue send after the append does not reject it.
 */
async function persistSlackMentionWithLock(args: {
  adapter: SlackAdapter;
  installation: SlackInstallationContext;
  message: Message;
  services: SlackWebhookServices;
  state: StateAdapter;
}): Promise<void> {
  const { message, threadId } = normalizeMessageThreadId(args.message);
  try {
    const routed = await withLock(
      args.state,
      `slack:ingress:${threadId}`,
      () =>
        persistSlackMessage({
          adapter: args.adapter,
          installation: args.installation,
          message,
          conversationStore: args.services.conversationStore,
          queue: args.services.queue,
          receivedAtMs: Date.now(),
          route: "mention",
          state: args.state,
        }),
      { keepAlive: true, waitMs: 10_000 },
    );
    if (!routed.acquired) {
      throw new Error("Could not acquire Slack ingress lock");
    }
  } catch (error) {
    if (error instanceof SlackEventPersistenceError && error.saved) {
      logException(error.cause, "slack.event.wake.failed");
      return;
    }
    throw error;
  }
}

/** Handle Slack webhooks by enqueueing durable conversation work. */
export async function handleSlackWebhook(args: {
  request: Request;
  services: SlackWebhookServices;
  waitUntil: WaitUntilFn;
}): Promise<Response> {
  const adapter = args.services.getSlackAdapter();
  const body = await args.request.text();

  if (!verifySlackSignature({ adapter, body, request: args.request })) {
    return new Response("Invalid signature", { status: 401 });
  }

  const contentType = args.request.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const state = args.services.state ?? getStateAdapter();
    return await handleSlackForm({
      adapter,
      body,
      getUserTokenStore: () => getUserTokenStore(args.services),
      isAuthorAllowed: (userId, installation) =>
        isSlackAuthorDomainAllowed({
          allowedBotUserIds: args.services.allowedBotUserIds ?? [],
          allowedDomains: args.services.allowedDomains ?? [],
          state,
          teamId: installation.teamId,
          user: userId,
        }),
      persistMessage: (message, installation) =>
        persistSlackMentionWithLock({
          adapter,
          installation,
          message,
          services: args.services,
          state,
        }),
      queue: args.services.queue,
      state,
      waitUntil: args.waitUntil,
    });
  }

  const result = slackEventEnvelopeSchema.safeParse(parseJson(body));
  if (!result.success) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const parsed = result.data;
  if (parsed.type === "url_verification") {
    return Response.json({ challenge: parsed.challenge });
  }

  if (parsed.type === "event_callback") {
    const eventLogContext = slackEventLogContext(parsed.event);
    if (shouldPersistBeforeAck(parsed)) {
      const failureResponse = await withLogContext(
        eventLogContext,
        async () => {
          try {
            await withSpan(
              "slack.message.ingress",
              "slack.message.ingress",
              eventLogContext,
              () =>
                handleSlackEvent({
                  body: parsed,
                  services: args.services,
                }),
              {
                ...slackMessageAttributes(parsed),
                "app.slack.membership": "not_checked",
              },
            );
          } catch (error) {
            // Any failure before durable mailbox append — installation/token
            // resolution, routing-state reads, persistence — must be retryable.
            // Acking 200 here would silently drop the user's message.
            if (error instanceof SlackEventPersistenceError) {
              logException(error.cause, "slack.event.persist.failed");
            } else {
              logException(error, "slack.event.routing.failed");
            }
            return new Response("Slack event handling failed", { status: 503 });
          }
          return undefined;
        },
      );
      if (failureResponse) {
        return failureResponse;
      }
    } else {
      enqueue(
        args.waitUntil,
        withLogContext(eventLogContext, () =>
          handleSlackEvent({
            body: parsed,
            services: args.services,
          }).catch((error) => {
            logException(error, "slack.event.enqueue.failed");
          }),
        ),
      );
    }
  }

  return new Response("ok", { status: 200 });
}
