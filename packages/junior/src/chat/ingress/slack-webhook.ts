import type { SlackAdapter, SlackEvent } from "@chat-adapter/slack";
import {
  ChannelImpl,
  ThreadImpl,
  type Message,
  type SlashCommandEvent,
  type StateAdapter,
} from "chat";
import type { SlackTurnRuntime } from "@/chat/runtime/slack-runtime";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import {
  buildSlackInboundMessage,
  type SlackConversationRoute,
} from "@/chat/task-execution/slack-work";
import {
  runWithSlackInstallation,
  verifySlackSignature,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import {
  extractMessageChangedMention,
  isMessageChangedEnvelope,
} from "@/chat/ingress/message-changed";
import { normalizeIncomingSlackThreadId } from "@/chat/ingress/message-router";
import { isExternalSlackUser } from "@/chat/ingress/workspace-membership";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { getStateAdapter } from "@/chat/state/adapter";
import { handleSlashCommand } from "@/chat/ingress/slash-command";
import { createRequester, parseActorUserId } from "@/chat/requester";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { logException, withSpan } from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

type SlackMessageEvent = {
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  event_ts?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
};

type SlackEventEnvelope = {
  enterprise_id?: string;
  event?: SlackMessageEvent & Record<string, unknown>;
  is_enterprise_install?: boolean;
  team_id?: string;
  type?: string;
};

const IGNORED_MESSAGE_SUBTYPES = new Set([
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

interface SlackInteractivePayload {
  actions?: Array<{
    action_id?: string;
    selected_option?: { value?: string };
    value?: string;
  }>;
  team?: { id?: string };
  type?: string;
  user?: { id?: string; name?: string; team_id?: string; username?: string };
}

class SlackEventPersistenceError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Slack event durable persistence failed");
    this.name = "SlackEventPersistenceError";
    this.cause = cause;
  }
}

export interface SlackWebhookServices {
  getUserTokenStore?: () => UserTokenStore;
  getSlackAdapter: () => SlackAdapter;
  queue: ConversationWorkQueue;
  conversationStore?: ConversationStore;
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

function isDmEvent(event: SlackMessageEvent): boolean {
  return event.channel_type === "im" || event.channel?.startsWith("D") === true;
}

function textMentionsBot(
  event: SlackMessageEvent,
  botUserId: string | undefined,
): boolean {
  return Boolean(botUserId && event.text?.includes(`<@${botUserId}>`));
}

function shouldIgnoreMessageSubtype(event: SlackMessageEvent): boolean {
  return Boolean(event.subtype && IGNORED_MESSAGE_SUBTYPES.has(event.subtype));
}

function normalizeMessageThreadId(message: Message): string {
  const normalized = normalizeIncomingSlackThreadId(message.threadId, message);
  if (normalized !== message.threadId) {
    (message as unknown as { threadId: string }).threadId = normalized;
  }
  return normalized;
}

async function buildThread(args: {
  adapter: SlackAdapter;
  message: Message;
  route: SlackConversationRoute;
  state: StateAdapter;
}): Promise<ThreadImpl> {
  const threadId = normalizeMessageThreadId(args.message);
  return new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: threadId,
    channelId: args.adapter.channelIdFromThreadId(threadId),
    channelVisibility: args.adapter.getChannelVisibility(threadId),
    currentMessage: args.message,
    initialMessage: args.message,
    isDM: args.adapter.isDM(threadId),
    isSubscribedContext: args.route === "subscribed",
  });
}

function shouldIgnoreMessage(message: Message): boolean {
  return (
    message.author.isMe === true ||
    !parseActorUserId(message.author.userId) ||
    isExternalSlackUser(message.raw as Record<string, unknown> | undefined)
  );
}

function shouldPersistBeforeAck(body: SlackEventEnvelope): boolean {
  return body.event?.type === "app_mention" || body.event?.type === "message";
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
}): Promise<void> {
  const thread = await buildThread(args);
  const inbound = buildSlackInboundMessage({
    conversationId: thread.id,
    installation: args.installation,
    message: args.message,
    receivedAtMs: args.receivedAtMs,
    route: args.route,
    thread,
  });
  await appendAndEnqueueInboundMessage({
    message: inbound,
    conversationStore: args.conversationStore,
    queue: args.queue,
    state: args.state,
  }).catch((error: unknown) => {
    throw new SlackEventPersistenceError(error);
  });
}

async function routeParsedMessage(args: {
  adapter: SlackAdapter;
  event: SlackMessageEvent;
  installation: SlackInstallationContext;
  message: Message;
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue;
  receivedAtMs: number;
  state: StateAdapter;
}): Promise<void> {
  if (shouldIgnoreMessage(args.message)) {
    return;
  }

  const threadId = normalizeMessageThreadId(args.message);
  const isMention =
    args.event.type === "app_mention" ||
    textMentionsBot(args.event, args.adapter.botUserId);
  if (isMention) {
    args.message.isMention = true;
  }

  const route: SlackConversationRoute | undefined =
    isDmEvent(args.event) || isMention
      ? "mention"
      : (await args.state.isSubscribed(threadId))
        ? "subscribed"
        : undefined;
  if (!route) {
    return;
  }

  await persistSlackMessage({
    adapter: args.adapter,
    installation: args.installation,
    message: args.message,
    conversationStore: args.conversationStore,
    queue: args.queue,
    receivedAtMs: args.receivedAtMs,
    route,
    state: args.state,
  });
}

async function handleMessageChanged(args: {
  adapter: SlackAdapter;
  body: unknown;
  installation: SlackInstallationContext;
  queue: ConversationWorkQueue;
  conversationStore?: ConversationStore;
  receivedAtMs: number;
  state: StateAdapter;
}): Promise<boolean> {
  if (!isMessageChangedEnvelope(args.body)) {
    return false;
  }
  const botUserId = args.adapter.botUserId;
  if (!botUserId) {
    // Entry classification requires resolved bot identity; degrading into
    // silently dropped edited-mention events would hide the outage. Throwing
    // makes the webhook return a retryable non-2xx so Slack redelivers.
    throw new Error(
      "Slack bot identity is unresolved; cannot classify message_changed event",
    );
  }

  const result = extractMessageChangedMention(
    args.body,
    botUserId,
    args.adapter,
  );
  if (!result || shouldIgnoreMessage(result.message)) {
    return true;
  }

  await persistSlackMessage({
    adapter: args.adapter,
    installation: args.installation,
    message: result.message,
    conversationStore: args.conversationStore,
    queue: args.queue,
    receivedAtMs: args.receivedAtMs,
    route: "mention",
    state: args.state,
  });
  return true;
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
    try {
      await publishAppHomeView(
        getSlackClient(),
        userId,
        getUserTokenStore(args.services),
      );
    } catch (error) {
      logException(error, "slack_app_home_publish_failed", {
        slackUserId: userId,
      });
    }
  }

  await runWithWorkspaceTeamId(installation.teamId, () =>
    runWithSlackInstallation({
      adapter,
      installation,
      state,
      task: async () => {
        if (
          await handleMessageChanged({
            adapter,
            body: args.body,
            installation,
            conversationStore: args.services.conversationStore,
            queue: args.services.queue,
            receivedAtMs,
            state,
          })
        ) {
          return;
        }

        if (event.type === "assistant_thread_started") {
          const assistantThread = (event as Record<string, unknown>)
            .assistant_thread as
            | {
                channel_id?: string;
                context?: { channel_id?: string };
                thread_ts?: string;
                user_id?: string;
              }
            | undefined;
          if (assistantThread?.channel_id && assistantThread.thread_ts) {
            await args.services.runtime.handleAssistantThreadStarted({
              channelId: assistantThread.channel_id,
              context: { channelId: assistantThread.context?.channel_id },
              threadId: adapter.encodeThreadId({
                channel: assistantThread.channel_id,
                threadTs: assistantThread.thread_ts,
              }),
              threadTs: assistantThread.thread_ts,
              userId: assistantThread.user_id,
            });
          }
          return;
        }

        if (event.type === "assistant_thread_context_changed") {
          const assistantThread = (event as Record<string, unknown>)
            .assistant_thread as
            | {
                channel_id?: string;
                context?: { channel_id?: string };
                thread_ts?: string;
                user_id?: string;
              }
            | undefined;
          if (assistantThread?.channel_id && assistantThread.thread_ts) {
            await args.services.runtime.handleAssistantContextChanged({
              channelId: assistantThread.channel_id,
              context: { channelId: assistantThread.context?.channel_id },
              threadId: adapter.encodeThreadId({
                channel: assistantThread.channel_id,
                threadTs: assistantThread.thread_ts,
              }),
              threadTs: assistantThread.thread_ts,
              userId: assistantThread.user_id,
            });
          }
          return;
        }

        if (event.type === "app_home_opened" && event.user) {
          await publishAppHomeViewBestEffort(event.user);
          return;
        }

        if (
          (event.type === "message" || event.type === "app_mention") &&
          !shouldIgnoreMessageSubtype(event) &&
          event.channel &&
          event.ts
        ) {
          const message = adapter.parseMessage(event as SlackEvent);
          await routeParsedMessage({
            adapter,
            event,
            installation,
            message,
            conversationStore: args.services.conversationStore,
            queue: args.services.queue,
            receivedAtMs,
            state,
          });
        }
      },
    }),
  );
}

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

async function handleSlashCommandForm(args: {
  adapter: SlackAdapter;
  params: URLSearchParams;
  state: StateAdapter;
}): Promise<void> {
  const raw = Object.fromEntries(args.params);
  const channelId = args.params.get("channel_id") ?? "";
  const channel = new ChannelImpl({
    id: channelId ? `slack:${channelId}` : "",
    adapter: args.adapter,
    stateAdapter: args.state,
  });
  const userId = requireSlackPayloadUserId(
    args.params.get("user_id"),
    "Slack slash command payload",
  );
  const teamId = args.params.get("team_id") ?? undefined;
  const userIdentity = createRequester(
    {
      platform: "slack",
      teamId,
      userId,
      userName: args.params.get("user_name") ?? undefined,
      fullName: args.params.get("user_name") ?? undefined,
    },
    { teamId, userId },
  );
  if (!userIdentity?.userId) {
    throw new Error("Slack slash command payload actor identity is invalid");
  }
  await withSpan(
    "chat.slash_command",
    "chat.slash_command",
    { slackUserId: userId },
    async () => {
      await handleSlashCommand({
        adapter: args.adapter,
        channel,
        command: args.params.get("command") || "",
        text: args.params.get("text") || "",
        triggerId: args.params.get("trigger_id") || undefined,
        raw,
        user: {
          userId,
          userName: userIdentity.userName ?? "",
          fullName: userIdentity.fullName ?? "",
          isBot: false,
          isMe: false,
        },
        openModal: async () => undefined,
      } satisfies SlashCommandEvent);
    },
  );
}

async function handleInteractivePayload(args: {
  payload: SlackInteractivePayload;
  userTokenStore: UserTokenStore;
}): Promise<void> {
  if (args.payload.type !== "block_actions") {
    return;
  }
  const action = args.payload.actions?.find(
    (candidate) => candidate.action_id === "app_home_disconnect",
  );
  const provider = action?.selected_option?.value ?? action?.value;
  if (!provider) {
    return;
  }
  const userId = requireSlackPayloadUserId(
    args.payload.user?.id,
    "Slack app home disconnect payload",
  );

  await withSpan(
    "chat.app_home_disconnect",
    "chat.app_home_disconnect",
    { slackUserId: userId },
    async () => {
      try {
        await unlinkProvider(userId, provider, args.userTokenStore);
      } catch (error) {
        logException(
          error,
          "app_home_disconnect_unlink_failed",
          { slackUserId: userId },
          { "app.credential.provider": provider },
        );
      }

      try {
        await publishAppHomeView(getSlackClient(), userId, args.userTokenStore);
      } catch (error) {
        logException(
          error,
          "app_home_disconnect_publish_failed",
          { slackUserId: userId },
          { "app.credential.provider": provider },
        );
      }
    },
  );
}

function installationFromForm(
  params: URLSearchParams,
): SlackInstallationContext {
  const isEnterpriseInstall = params.get("is_enterprise_install") === "true";
  return {
    teamId: params.get("team_id") ?? undefined,
    enterpriseId: params.get("enterprise_id") ?? undefined,
    isEnterpriseInstall,
  };
}

function installationFromInteractive(
  payload: SlackInteractivePayload,
): SlackInstallationContext {
  return {
    teamId: payload.team?.id ?? payload.user?.team_id,
  };
}

async function handleSlackForm(args: {
  body: string;
  services: SlackWebhookServices;
  waitUntil: WaitUntilFn;
}): Promise<Response> {
  const params = new URLSearchParams(args.body);
  const adapter = args.services.getSlackAdapter();
  const state = args.services.state ?? getStateAdapter();
  await state.connect();

  if (params.has("command") && !params.has("payload")) {
    const installation = installationFromForm(params);
    enqueue(
      args.waitUntil,
      runWithWorkspaceTeamId(installation.teamId, () =>
        runWithSlackInstallation({
          adapter,
          installation,
          state,
          task: () =>
            handleSlashCommandForm({
              adapter,
              params,
              state,
            }),
        }),
      ).catch((error) => {
        logException(error, "slash_command_failed", {
          slackUserId: params.get("user_id") ?? undefined,
        });
      }),
    );
    return new Response("", { status: 200 });
  }

  const rawPayload = params.get("payload");
  if (!rawPayload) {
    return new Response("Missing payload", { status: 400 });
  }
  const payload = parseJson(rawPayload) as SlackInteractivePayload | undefined;
  if (!payload) {
    return new Response("Invalid payload JSON", { status: 400 });
  }
  const installation = installationFromInteractive(payload);

  enqueue(
    args.waitUntil,
    runWithWorkspaceTeamId(installation.teamId, () =>
      runWithSlackInstallation({
        adapter,
        installation,
        state,
        task: () =>
          handleInteractivePayload({
            payload,
            userTokenStore: getUserTokenStore(args.services),
          }),
      }),
    ).catch((error) => {
      logException(error, "slack_interactive_payload_failed", {
        slackUserId: payload.user?.id?.trim() || undefined,
      });
    }),
  );
  return new Response("", { status: 200 });
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
    return await handleSlackForm({
      body,
      services: args.services,
      waitUntil: args.waitUntil,
    });
  }

  const parsed = parseJson(body) as SlackEventEnvelope | undefined;
  if (!parsed) {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (parsed.type === "url_verification") {
    const challenge = (parsed as { challenge?: unknown }).challenge;
    return Response.json({ challenge });
  }

  if (parsed.type === "event_callback") {
    const eventTask = handleSlackEvent({
      body: parsed,
      services: args.services,
    });
    if (shouldPersistBeforeAck(parsed)) {
      try {
        await eventTask;
      } catch (error) {
        // Any failure before durable mailbox append — installation/token
        // resolution, routing-state reads, persistence — must be retryable.
        // Acking 200 here would silently drop the user's message.
        if (error instanceof SlackEventPersistenceError) {
          logException(error.cause, "slack_event_persist_failed");
        } else {
          logException(error, "slack_event_routing_failed");
        }
        return new Response("Slack event handling failed", { status: 503 });
      }
    } else {
      enqueue(
        args.waitUntil,
        eventTask.catch((error) => {
          logException(error, "slack_event_enqueue_failed");
        }),
      );
    }
  }

  return new Response("ok", { status: 200 });
}
