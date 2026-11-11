import { presentSlackAnnotationDetails } from "@/chat/slack/annotation-details";
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  slackAssistantThreadSchema,
  slackChannelScope,
  slackEventEnvelopeSchema,
  type SlackEventEnvelope,
  type SlackInboundEvent,
} from "./slack-payload";
import { unfurlDashboardConversationLinks } from "./slack-conversation-unfurl";
import { handleSlackForm } from "./slack-form";
import { saveSkippedSlackMessage } from "./slack-skipped-message";
import { resumeConversationDelivery } from "@/chat/conversations/delivery-pause";
import { handleSlackStop, slackStopButtonRequest } from "./slack-stop";
import type { SlackInteractionInputFacts } from "./slack-interaction-input";
import { shouldIgnoreMessageSubtype } from "./slack-message-subtypes";
import {
  joinCreatedSlackChannel,
  slackChannelCreatedEnvelopeSchema,
} from "./slack-channel-created";
import { ThreadImpl, type Message, type StateAdapter } from "chat";
import type { SlackTurnRuntime } from "@/chat/providers/slack/runtime";
import {
  startProcessingReaction,
  type ProcessingReaction,
} from "@/chat/providers/slack/processing-reaction";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import type { InboundMessage } from "@/chat/task-execution/state";
import { withLock } from "@/chat/state/locks";
import {
  buildSlackInboundMessage,
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
  type SlackChannelMessageAuthor,
} from "@/chat/slack/channel-message-events";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { botConfig } from "@/chat/config";
import {
  getThreadStopDecision,
  SubscribedReplyReason,
} from "@/chat/services/subscribed-decision";
import { parseContent } from "@/chat/slack/message/content";
import { stripLeadingBotMention } from "@/chat/runtime/thread-context";
import {
  normalizeIncomingSlackThreadId,
  withNormalizedThreadId,
} from "@/chat/ingress/message-router";
import {
  isSlackWorkspaceMember,
  slackWorkspaceBotId,
} from "@/chat/ingress/workspace-membership";
import { isSlackAuthorDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { slackMessageAttributes } from "./slack-message-telemetry";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import { getStateAdapter } from "@/chat/state/adapter";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { closeReviewItemsAnsweredByReply } from "@/chat/review-items/actions";
import { SlackEventPersistenceError } from "./slack-event-persistence-error";
import { createSlackActor, parseActorUserId } from "@/chat/actor";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { bindMessageAuthorIdentityId } from "@/chat/services/message-actor-identity";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { createSlackReviewItemShow } from "@/chat/slack/review-item-card-sync";
import { presentSlackAutomationDetails } from "@/chat/slack/automation-details";
import { getSlackClient } from "@/chat/slack/client";
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

export interface SlackWebhookServices {
  getUserTokenStore?: () => UserTokenStore;
  getSlackAdapter: () => SlackAdapter;
  queue: ConversationWorkQueue;
  conversationStore?: ConversationStore;
  /** Email domains Slack authors need to start a Turn. Empty allows all. */
  allowedDomains?: readonly string[];
  /** Slack user IDs of bots that may start a Turn without an email domain. */
  allowedBotUserIds?: readonly string[];
  /** Join each public channel created after this is on. Defaults to off. */
  autoJoinNewChannels?: boolean;
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
  body: Pick<
    SlackEventEnvelope,
    "enterprise_id" | "is_enterprise_install" | "team_id"
  >,
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

/**
 * Resolve the Slack author Identity at ingress and bind its id to the message.
 * Ingress does no profile lookup. The worker adds the profile names later.
 * Bot authors wait for their own bot Identity, so they get no id here.
 */
async function bindSlackAuthorIdentity(
  message: Message,
  installation: SlackInstallationContext,
): Promise<void> {
  const teamId = installation.teamId;
  const userId = parseActorUserId(message.author.userId);
  if (!teamId || !userId || message.author.isBot === true) {
    return;
  }
  bindMessageAuthorIdentityId(
    message,
    await resolveActorIdentityId(
      getSqlExecutor(),
      createSlackActor(teamId, userId, null),
    ),
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

/**
 * Build the mailbox input for one Slack message. A message and a `stop` get
 * the same `inboundMessageId`, so each Slack message is handled once.
 */
async function buildSlackInput(args: {
  adapter: SlackAdapter;
  conversationId: string;
  facts?: SlackInteractionInputFacts;
  installation: SlackInstallationContext;
  message: Message;
  receivedAtMs: number;
  route: SlackConversationRoute;
  state: StateAdapter;
}): Promise<{ inbound: InboundMessage; thread: ThreadImpl }> {
  const thread = await buildThread(args);
  return {
    inbound: buildSlackInboundMessage({
      conversationId: args.conversationId,
      installation: args.installation,
      reviewItemChange: args.facts?.reviewItemChange,
      message: args.message,
      receivedAtMs: args.receivedAtMs,
      route: args.route,
      thread,
    }),
    thread,
  };
}

async function persistSlackMessage(args: {
  adapter: SlackAdapter;
  facts?: SlackInteractionInputFacts;
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
  const { inbound, thread } = await buildSlackInput({
    ...args,
    conversationId,
  });
  const work = await getConversationWorkState({
    conversationId,
    state: args.state,
  });
  let receipt: ProcessingReaction | undefined;
  if (
    args.route === "mention" &&
    !work?.execution.inboundMessageIds.includes(inbound.inboundMessageId)
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
 * Whether a Slack message mentions Junior in its text or section blocks.
 * Slack still emits app_mention for tokens inside code spans/blocks. Only
 * mentions that sit outside code count.
 */
function eventMentionsBot(
  event: SlackInboundEvent,
  botUserId: string | undefined,
): boolean {
  return Boolean(
    botUserId &&
    (textMentionsBot(event.text ?? "", botUserId) ||
      event.blocks?.some(
        (block) =>
          block.type === "section" &&
          typeof block.text === "object" &&
          block.text.type === "mrkdwn" &&
          textMentionsBot(block.text.text, botUserId),
      )),
  );
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
  /** Run the task after the caller releases the thread's ingress lock. */
  runAfterUnlock: (task: () => Promise<void>) => void;
  state: StateAdapter;
}): Promise<void> {
  if (shouldIgnoreMessage(args.message)) {
    return;
  }

  const normalized = normalizeMessageThreadId(args.message);
  const message = normalized.message;
  const canonicalThreadId = normalized.threadId;
  const isMention = eventMentionsBot(args.event, args.adapter.botUserId);
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
    await ingestChannelMessage({
      author: { kind: "user", userId: message.author.userId },
      event: args.event,
      queue: args.queue,
      teamId: args.installation.teamId,
    });
    return;
  }

  const stopDecision = getThreadStopDecision({
    botUserName: botConfig.userName,
    rawText: args.event.text ?? "",
    text: args.event.text ?? "",
    isExplicitMention: isMention,
  });
  const isAuthorDomainAllowed = () =>
    isSlackAuthorDomainAllowed({
      allowedBotUserIds: args.allowedBotUserIds,
      allowedDomains: args.allowedDomains,
      state: args.state,
      teamId: args.installation.teamId,
      user: args.event.user,
    });
  // Passive thread messages and stops are not checked for the allowed domains.
  if (
    !stopDecision &&
    route === "mention" &&
    !(await isAuthorDomainAllowed())
  ) {
    return;
  }

  await bindSlackAuthorIdentity(message, args.installation);
  const conversationId = await resolveSlackConversationId({
    canonicalThreadId,
    conversationStore: args.conversationStore,
    installation: args.installation,
  });

  if (stopDecision) {
    const { inbound } = await buildSlackInput({
      adapter: args.adapter,
      conversationId,
      installation: args.installation,
      message,
      receivedAtMs: args.receivedAtMs,
      route,
      state: args.state,
    });
    await handleSlackStop({
      adapter: args.adapter,
      canonicalThreadId,
      conversationId,
      conversationStore: args.conversationStore,
      queue: args.queue,
      request: inbound,
      slackThread: parseSlackThreadId(canonicalThreadId),
      state: args.state,
      stopMessage: {
        message,
        stopReason: stopDecision.reasonDetail ?? stopDecision.reason,
      },
    });
    return;
  }

  // A mention in the thread attaches a detached Conversation again.
  if (route === "mention") {
    await resumeConversationDelivery(conversationId);
  }

  // Keep non-mention thread messages as Conversation history without waking a
  // worker when passive routing is off. Later explicit mentions still need them.
  // Write to the Conversation that owns the thread, which mention Turns read.
  if (isSubscribed && !isExperimentalFeatureEnabled("passive-routing")) {
    await saveSkippedSlackMessage({
      conversationId,
      message,
      skippedReason: `${SubscribedReplyReason.PassiveDisabled}:passive-routing`,
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
  // A message from a person to Junior answers the open questions that the
  // agent asked in this Conversation, like a click on their cards. A reply in
  // a subscribed thread starts a Turn too, so it answers in the same way. It
  // skips the allowed domain check above. The close checks the domain only
  // when an open item can match, so most replies need no profile lookup.
  const closeAnswered = async () => {
    if (message.author.isBot === true) return;
    await closeReviewItemsAnsweredByReply({
      ...(route === "subscribed"
        ? { canAnswer: isAuthorDomainAllowed }
        : undefined),
      conversationId,
      delivery: {
        queue: args.queue,
        show: createSlackReviewItemShow(() => args.adapter),
      },
      resolveUser: async () => {
        const teamId = args.installation.teamId;
        const userId = parseActorUserId(message.author.userId);
        if (!teamId || !userId) return undefined;
        return (await readActorIdentity(createSlackActor(teamId, userId, null)))
          ?.user;
      },
      text: stripLeadingBotMention(parseContent(message).topLevelText, {
        botUserId: args.adapter.botUserId,
        stripLeadingSlackMentionToken: true,
      }),
    });
  };
  // The close can call the decision model, so it runs after the ingress
  // lock is released and does not block later messages in the thread.
  try {
    await persist();
  } catch (error) {
    // A failed queue wake can follow a saved reply. The reply still answers.
    if (error instanceof SlackEventPersistenceError && error.saved) {
      args.runAfterUnlock(closeAnswered);
    }
    throw error;
  }
  args.runAfterUnlock(closeAnswered);
}

/**
 * Run the channel-message automations of the channel for a new message or
 * thread reply.
 */
async function ingestChannelMessage(args: {
  author: SlackChannelMessageAuthor;
  event: SlackInboundEvent;
  queue: ConversationWorkQueue;
  teamId?: string;
}): Promise<void> {
  // Use only `message`: Slack also sends `app_mention` for a mention in code.
  const { event } = args;
  if (event.type !== "message" || !event.channel || !event.ts || !args.teamId) {
    return;
  }
  const channelMessage = slackChannelMessageEvent({
    author: args.author,
    botId: event.bot_id,
    channelId: event.channel,
    subtype: event.subtype,
    text: event.text,
    threadTs: event.thread_ts,
    ts: event.ts,
  });
  if (!channelMessage) return;
  await ingestEventAutomations(
    { ...channelMessage, namespace: SLACK_EVENT_NAMESPACE },
    { queue: args.queue, teamId: args.teamId },
  );
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
  const channelScope = slackChannelScope(args.body);
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

        if (event.type === "link_shared") {
          await unfurlDashboardConversationLinks({
            event,
            channelScope,
            state,
            teamId: installation.teamId,
          });
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
            async () => {
              const canonicalThreadId = `slack:${channelId}:${threadTs}`;
              const conversationId = await resolveSlackConversationId({
                canonicalThreadId,
                conversationStore: args.services.conversationStore,
                installation,
              });
              await handleSlackStop({
                adapter,
                canonicalThreadId,
                conversationId,
                conversationStore: args.services.conversationStore,
                queue: args.services.queue,
                request: event.event_ts
                  ? slackStopButtonRequest({
                      channelId,
                      conversationId,
                      eventTs: event.event_ts,
                      installation,
                    })
                  : undefined,
                slackThread: { channelId, threadTs },
                state,
              });
            },
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
          // A post with a bot ID and no user, such as from an app
          // integration, runs only channel-message automations that name the
          // bot. It never starts a Turn. A post that mentions Junior runs
          // nothing, the same as a mention from a person.
          if (event.user === undefined && event.bot_id !== undefined) {
            const botId = await slackWorkspaceBotId(event, channelScope, state);
            setSpanAttributes({
              "app.slack.membership": botId ? "verified" : "unverified",
            });
            if (!botId || eventMentionsBot(event, adapter.botUserId)) return;
            await ingestChannelMessage({
              author: { kind: "bot", botId },
              event,
              queue: args.services.queue,
              teamId: installation.teamId,
            });
            return;
          }
          const member = await isSlackWorkspaceMember(event, state);
          setSpanAttributes({
            "app.slack.membership": member ? "verified" : "unverified",
          });
          if (!member) return;
          const message = adapter.parseMessage(event);
          let afterUnlock: (() => Promise<void>) | undefined;
          // The task runs after the lock is released, also when routing throws.
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
                runAfterUnlock: (task) => {
                  afterUnlock = task;
                },
                state,
              }),
            { keepAlive: true, waitMs: 10_000 },
          ).finally(() => afterUnlock?.());
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
  facts?: SlackInteractionInputFacts;
  installation: SlackInstallationContext;
  message: Message;
  services: SlackWebhookServices;
  state: StateAdapter;
}): Promise<void> {
  const { message, threadId } = normalizeMessageThreadId(args.message);
  await bindSlackAuthorIdentity(message, args.installation);
  try {
    const routed = await withLock(
      args.state,
      `slack:ingress:${threadId}`,
      () =>
        persistSlackMessage({
          adapter: args.adapter,
          facts: args.facts,
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
      persistMessage: (message, installation, facts) =>
        persistSlackMentionWithLock({
          adapter,
          facts,
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

  const json = parseJson(body);
  const channelCreated = slackChannelCreatedEnvelopeSchema.safeParse(json);
  if (channelCreated.success) {
    if (args.services.autoJoinNewChannels) {
      const channelId = channelCreated.data.event.channel.id;
      enqueue(
        args.waitUntil,
        withLogContext({ platform: "slack", destinationName: channelId }, () =>
          joinCreatedSlackChannel({
            adapter,
            channelId,
            installation: installationFromEnvelope(channelCreated.data),
            state: args.services.state ?? getStateAdapter(),
          }).catch((error) => {
            logException(error, "slack.channel.auto_join.failed");
          }),
        ),
      );
    }
    return new Response("ok", { status: 200 });
  }

  const result = slackEventEnvelopeSchema.safeParse(json);
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
