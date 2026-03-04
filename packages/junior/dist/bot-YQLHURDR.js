import {
  GEN_AI_PROVIDER_NAME,
  buildSlackOutputMessage,
  completeObject,
  completeText,
  ensureBlockSpacing,
  escapeXml,
  generateAssistantReply,
  getOAuthProviderConfig,
  getUserTokenStore,
  isExplicitChannelPostIntent,
  isPluginProvider,
  listThreadReplies,
  publishAppHomeView,
  startOAuthFlow,
  truncateStatusText
} from "./chunk-YA6U75SZ.js";
import {
  claimWorkflowIngressDedup,
  getStateAdapter
} from "./chunk-KZCA5IWS.js";
import {
  downloadPrivateSlackFile,
  getSlackClient,
  isDmChannel
} from "./chunk-ZPT66GNA.js";
import {
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setTags,
  toOptionalString,
  withContext,
  withSpan
} from "./chunk-PZF6TC63.js";
import {
  botConfig,
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret
} from "./chunk-OXUT4WDZ.js";

// src/chat/bot.ts
import { Chat as Chat2 } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";

// src/chat/chat-background-patch.ts
import { Chat } from "chat";
var PATCH_FLAG = /* @__PURE__ */ Symbol.for("junior.chat.backgroundPatch");
var WORKFLOW_INGRESS_DEDUP_TTL_MS = 24 * 60 * 60 * 1e3;
function nonEmptyString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed || void 0;
}
function serializeMessageForWorkflow(message) {
  const candidate = message;
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON();
  }
  return {
    _type: "chat:Message",
    ...message
  };
}
function serializeThreadForWorkflow(thread) {
  const candidate = thread;
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON();
  }
  return {
    _type: "chat:Thread",
    ...thread
  };
}
function normalizeIncomingSlackThreadId(threadId, message) {
  if (!threadId.startsWith("slack:")) {
    return threadId;
  }
  if (!message || typeof message !== "object") {
    return threadId;
  }
  const raw = message.raw;
  if (!raw || typeof raw !== "object") {
    return threadId;
  }
  const channelId = nonEmptyString(raw.channel);
  const threadTs = nonEmptyString(raw.thread_ts) ?? nonEmptyString(raw.ts);
  if (!channelId || !threadTs) {
    return threadId;
  }
  return `slack:${channelId}:${threadTs}`;
}
function buildWorkflowIngressDedupKey(normalizedThreadId, messageId) {
  return `${normalizedThreadId}:${messageId}`;
}
function determineThreadMessageKind(args) {
  if (args.isSubscribed) {
    return "subscribed_message";
  }
  if (args.isMention) {
    return "new_mention";
  }
  return void 0;
}
var defaultWorkflowRoutingDeps = {
  claimDedup: (key, ttlMs) => claimWorkflowIngressDedup(key, ttlMs),
  getIsSubscribed: (threadId) => getStateAdapter().isSubscribed(threadId),
  logInfo,
  routeToThreadWorkflow: async (normalizedThreadId, payload) => {
    const { routeToThreadWorkflow } = await import("./router-IRVIUTVH.js");
    return await routeToThreadWorkflow(normalizedThreadId, payload);
  }
};
async function routeIncomingMessageToWorkflow(args) {
  const deps = args.deps ?? defaultWorkflowRoutingDeps;
  const { adapter, runtime } = args;
  const message = args.message;
  if (!message || typeof message !== "object") {
    return "ignored_non_object";
  }
  const normalizedThreadId = normalizeIncomingSlackThreadId(args.threadId, message);
  if ("threadId" in message) {
    message.threadId = normalizedThreadId;
  }
  const typedMessage = message;
  if (typedMessage.author?.isMe) {
    return "ignored_self_message";
  }
  const messageId = nonEmptyString(typedMessage.id);
  if (!messageId) {
    return "ignored_missing_message_id";
  }
  const isSubscribed = await deps.getIsSubscribed(normalizedThreadId);
  const isMention = Boolean(typedMessage.isMention || runtime.detectMention?.(adapter, message));
  const kind = determineThreadMessageKind({
    isSubscribed,
    isMention
  });
  if (!kind) {
    return "ignored_unsubscribed_non_mention";
  }
  const dedupKey = buildWorkflowIngressDedupKey(normalizedThreadId, messageId);
  const claimed = await deps.claimDedup(dedupKey, WORKFLOW_INGRESS_DEDUP_TTL_MS);
  if (!claimed) {
    deps.logInfo(
      "workflow_ingress_dedup_hit",
      {
        slackThreadId: normalizedThreadId,
        slackUserId: message.author.userId
      },
      {
        "messaging.message.id": messageId,
        "app.workflow.message_kind": kind,
        "app.workflow.dedup_key": dedupKey,
        "app.workflow.dedup_outcome": "duplicate"
      },
      "Skipping duplicate incoming message before workflow routing"
    );
    return "ignored_duplicate";
  }
  const thread = await runtime.createThread(adapter, normalizedThreadId, message, isSubscribed);
  const serializedMessage = serializeMessageForWorkflow(message);
  const serializedThread = serializeThreadForWorkflow(thread);
  const payload = {
    dedupKey,
    kind,
    message: serializedMessage,
    normalizedThreadId,
    thread: serializedThread
  };
  await withContext(
    {
      slackThreadId: normalizedThreadId,
      slackChannelId: thread.channelId,
      slackUserId: message.author.userId
    },
    async () => {
      let routedRunId;
      await withSpan(
        "workflow.route_message",
        "workflow.route_message",
        {
          slackThreadId: normalizedThreadId,
          slackChannelId: thread.channelId,
          slackUserId: message.author.userId,
          workflowRunId: routedRunId
        },
        async () => {
          routedRunId = await deps.routeToThreadWorkflow(normalizedThreadId, payload);
          if (routedRunId) {
            setSpanAttributes({
              "app.workflow.run_id": routedRunId
            });
          }
        },
        {
          "messaging.message.id": messageId,
          "app.workflow.message_kind": kind
        }
      );
      deps.logInfo(
        "workflow_ingress_enqueued",
        {},
        {
          "messaging.message.id": messageId,
          "app.workflow.message_kind": kind,
          "app.workflow.dedup_key": dedupKey,
          "app.workflow.dedup_outcome": "primary",
          ...routedRunId ? { "app.workflow.run_id": routedRunId } : {}
        },
        "Routing incoming message to thread workflow"
      );
    }
  );
  return "routed";
}
function scheduleBackgroundWork(options, run, onUnhandledError) {
  if (options?.waitUntil) {
    options.waitUntil(run);
    return;
  }
  const task = run();
  void task.catch((error) => {
    onUnhandledError?.(error);
  });
}
function installChatBackgroundPatch() {
  const target = Chat.prototype;
  if (target[PATCH_FLAG]) {
    return;
  }
  target[PATCH_FLAG] = true;
  const chatProto = Chat.prototype;
  chatProto.processMessage = function processMessage(adapter, threadId, messageOrFactory, options) {
    const run = async () => {
      try {
        const message = typeof messageOrFactory === "function" ? await messageOrFactory() : messageOrFactory;
        const result = await routeIncomingMessageToWorkflow({
          adapter,
          threadId,
          message,
          runtime: {
            createThread: this.createThread.bind(this),
            detectMention: this.detectMention?.bind(this)
          }
        });
        if (result === "ignored_missing_message_id") {
          const normalizedThreadId = normalizeIncomingSlackThreadId(threadId, message);
          this.logger?.error?.("Message processing error", {
            threadId: normalizedThreadId,
            reason: "missing_message_id"
          });
        }
      } catch (err) {
        this.logger?.error?.("Message processing error", { error: err, threadId });
        throw err;
      }
    };
    scheduleBackgroundWork(options, run);
  };
  chatProto.processReaction = function processReaction(event, options) {
    const run = async () => {
      try {
        await this.handleReactionEvent(event);
      } catch (err) {
        this.logger?.error?.("Reaction processing error", {
          error: err,
          emoji: event.emoji,
          messageId: event.messageId
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Reaction processing error", {
        error,
        emoji: event.emoji,
        messageId: event.messageId
      });
    });
  };
  chatProto.processAction = function processAction(event, options) {
    const run = async () => {
      try {
        await this.handleActionEvent(event);
      } catch (err) {
        this.logger?.error?.("Action processing error", {
          error: err,
          actionId: event.actionId,
          messageId: event.messageId
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Action processing error", {
        error,
        actionId: event.actionId,
        messageId: event.messageId
      });
    });
  };
  chatProto.processModalClose = function processModalClose(event, contextId, options) {
    const run = async () => {
      try {
        const { relatedThread, relatedMessage, relatedChannel } = await this.retrieveModalContext(event.adapter.name, contextId);
        const fullEvent = { ...event, relatedThread, relatedMessage, relatedChannel };
        for (const { callbackIds, handler } of this.modalCloseHandlers) {
          if (callbackIds.length === 0 || callbackIds.includes(event.callbackId)) {
            await handler(fullEvent);
          }
        }
      } catch (err) {
        this.logger?.error?.("Modal close handler error", {
          error: err,
          callbackId: event.callbackId
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Modal close handler error", {
        error,
        callbackId: event.callbackId
      });
    });
  };
  chatProto.processSlashCommand = function processSlashCommand(event, options) {
    const run = async () => {
      try {
        await this.handleSlashCommandEvent(event);
      } catch (err) {
        this.logger?.error?.("Slash command processing error", {
          error: err,
          command: event.command,
          text: event.text
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Slash command processing error", {
        error,
        command: event.command,
        text: event.text
      });
    });
  };
  chatProto.processAssistantThreadStarted = function processAssistantThreadStarted(event, options) {
    const run = async () => {
      try {
        for (const handler of this.assistantThreadStartedHandlers) {
          await handler(event);
        }
      } catch (err) {
        this.logger?.error?.("Assistant thread started handler error", {
          error: err,
          threadId: event.threadId
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Assistant thread started handler error", {
        error,
        threadId: event.threadId
      });
    });
  };
  chatProto.processAssistantContextChanged = function processAssistantContextChanged(event, options) {
    const run = async () => {
      try {
        for (const handler of this.assistantContextChangedHandlers) {
          await handler(event);
        }
      } catch (err) {
        this.logger?.error?.("Assistant context changed handler error", {
          error: err,
          threadId: event.threadId
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Assistant context changed handler error", {
        error,
        threadId: event.threadId
      });
    });
  };
  chatProto.processAppHomeOpened = function processAppHomeOpened(event, options) {
    const run = async () => {
      try {
        for (const handler of this.appHomeOpenedHandlers) {
          await handler(event);
        }
      } catch (err) {
        this.logger?.error?.("App home opened handler error", {
          error: err,
          userId: event.userId
        });
      }
    };
    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("App home opened handler error", {
        error,
        userId: event.userId
      });
    });
  };
}
installChatBackgroundPatch();

// src/chat/app-runtime.ts
function isExplicitMentionDecision(reason) {
  return reason === "explicit mention" || reason === "explicit_mention" || reason.startsWith("explicit_mention:");
}
function buildLogContext(deps, args) {
  return {
    slackThreadId: args.threadId,
    slackUserId: args.requesterId,
    slackUserName: args.requesterUserName,
    slackChannelId: args.channelId,
    workflowRunId: args.workflowRunId,
    assistantUserName: deps.assistantUserName,
    modelId: deps.modelId
  };
}
function createAppSlackRuntime(deps) {
  const logContext = (args) => buildLogContext(deps, args);
  return {
    async handleNewMention(thread, message) {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const workflowRunId = deps.getWorkflowRunId(thread, message);
        const context = logContext({
          threadId,
          channelId,
          requesterId: message.author.userId,
          requesterUserName: message.author.userName,
          workflowRunId
        });
        await deps.withSpan(
          "workflow.chat_turn",
          "workflow.chat_turn",
          context,
          async () => {
            await thread.subscribe();
            await deps.replyToThread(thread, message, {
              explicitMention: true
            });
          }
        );
      } catch (error) {
        deps.logException(
          error,
          "mention_handler_failed",
          logContext({
            threadId: deps.getThreadId(thread, message),
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId: deps.getChannelId(thread, message),
            workflowRunId: deps.getWorkflowRunId(thread, message)
          }),
          {},
          "onNewMention failed"
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        await thread.post(`Error: ${errorMessage}`);
      }
    },
    async handleSubscribedMessage(thread, message) {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const workflowRunId = deps.getWorkflowRunId(thread, message);
        const rawUserText = message.text;
        const userText = deps.stripLeadingBotMention(rawUserText, {
          stripLeadingSlackMentionToken: Boolean(message.isMention)
        });
        const context = {
          threadId,
          requesterId: message.author.userId,
          channelId,
          workflowRunId
        };
        const preparedState = await deps.prepareTurnState({
          thread,
          message,
          userText,
          explicitMention: Boolean(message.isMention),
          context
        });
        await deps.persistPreparedState({
          thread,
          preparedState
        });
        const decision = await deps.shouldReplyInSubscribedThread({
          rawText: rawUserText,
          text: userText,
          conversationContext: deps.getPreparedConversationContext(preparedState),
          hasAttachments: message.attachments.length > 0,
          isExplicitMention: Boolean(message.isMention),
          context
        });
        if (!decision.shouldReply) {
          deps.logWarn(
            "subscribed_message_reply_skipped",
            logContext({
              threadId,
              requesterId: message.author.userId,
              requesterUserName: message.author.userName,
              channelId,
              workflowRunId
            }),
            {
              "app.decision.reason": decision.reason
            },
            "Skipping subscribed message reply"
          );
          await deps.onSubscribedMessageSkipped({
            thread,
            message,
            preparedState,
            decision,
            completedAtMs: deps.now()
          });
          return;
        }
        await deps.withSpan(
          "workflow.chat_turn",
          "workflow.chat_turn",
          logContext({
            threadId,
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId,
            workflowRunId
          }),
          async () => {
            await deps.replyToThread(thread, message, {
              explicitMention: isExplicitMentionDecision(decision.reason),
              preparedState
            });
          }
        );
      } catch (error) {
        deps.logException(
          error,
          "subscribed_message_handler_failed",
          logContext({
            threadId: deps.getThreadId(thread, message),
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId: deps.getChannelId(thread, message),
            workflowRunId: deps.getWorkflowRunId(thread, message)
          }),
          {},
          "onSubscribedMessage failed"
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        await thread.post(`Error: ${errorMessage}`);
      }
    },
    async handleAssistantThreadStarted(event) {
      try {
        await deps.initializeAssistantThread({
          threadId: event.threadId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          sourceChannelId: event.context?.channelId
        });
      } catch (error) {
        deps.logException(
          error,
          "assistant_thread_started_handler_failed",
          {
            slackThreadId: event.threadId,
            slackUserId: event.userId,
            slackChannelId: event.channelId,
            assistantUserName: deps.assistantUserName,
            modelId: deps.modelId
          },
          {},
          "onAssistantThreadStarted failed"
        );
      }
    },
    async handleAssistantContextChanged(event) {
      try {
        await deps.initializeAssistantThread({
          threadId: event.threadId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          sourceChannelId: event.context?.channelId
        });
      } catch (error) {
        deps.logException(
          error,
          "assistant_context_changed_handler_failed",
          {
            slackThreadId: event.threadId,
            slackUserId: event.userId,
            slackChannelId: event.channelId,
            assistantUserName: deps.assistantUserName,
            modelId: deps.modelId
          },
          {},
          "onAssistantContextChanged failed"
        );
      }
    }
  };
}

// src/chat/slash-command.ts
function providerLabel(provider) {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
async function postEphemeral(event, text) {
  await event.channel.postEphemeral(event.user, text, { fallbackToDM: false });
}
async function handleLink(event, provider) {
  if (!isPluginProvider(provider)) {
    await postEphemeral(event, `Unknown provider: \`${provider}\``);
    return;
  }
  if (!getOAuthProviderConfig(provider)) {
    await postEphemeral(
      event,
      `${providerLabel(provider)} uses app-level authentication and doesn't require account linking.`
    );
    return;
  }
  const raw = event.raw;
  const result = await startOAuthFlow(provider, {
    requesterId: event.user.userId,
    channelId: raw.channel_id
  });
  if (!result.ok) {
    await postEphemeral(event, `Failed to start linking: ${result.error}`);
    return;
  }
  if (result.delivery === "fallback_dm") {
    await postEphemeral(event, `Check your DMs for a ${providerLabel(provider)} authorization link.`);
  } else if (result.delivery === false) {
    await postEphemeral(
      event,
      "I wasn't able to send you a private authorization link. Please try again in a direct message."
    );
  }
}
async function handleUnlink(event, provider) {
  if (!isPluginProvider(provider)) {
    await postEphemeral(event, `Unknown provider: \`${provider}\``);
    return;
  }
  if (!getOAuthProviderConfig(provider)) {
    await postEphemeral(
      event,
      `${providerLabel(provider)} uses app-level authentication and can't be unlinked.`
    );
    return;
  }
  const tokenStore = getUserTokenStore();
  await tokenStore.delete(event.user.userId, provider);
  logInfo(
    "slash_command_unlink",
    { slackUserId: event.user.userId },
    { "app.credential.provider": provider },
    `Unlinked ${providerLabel(provider)} account via /jr slash command`
  );
  await postEphemeral(event, `Your ${providerLabel(provider)} account has been unlinked.`);
}
async function handleSlashCommand(event) {
  const [subcommand, provider, ...rest] = event.text.trim().split(/\s+/);
  if (!subcommand || !["link", "unlink"].includes(subcommand)) {
    await postEphemeral(event, "Usage: `/jr link <provider>` or `/jr unlink <provider>`");
    return;
  }
  if (!provider || rest.length > 0) {
    await postEphemeral(event, `Usage: \`/jr ${subcommand} <provider>\``);
    return;
  }
  const normalized = provider.toLowerCase();
  if (subcommand === "link") {
    await handleLink(event, normalized);
  } else {
    await handleUnlink(event, normalized);
  }
}

// src/chat/bootstrap/register-handlers.ts
function registerBotHandlers(args) {
  const { bot: bot2, appSlackRuntime: appSlackRuntime2 } = args;
  bot2.onNewMention(appSlackRuntime2.handleNewMention);
  bot2.onSubscribedMessage(appSlackRuntime2.handleSubscribedMessage);
  bot2.onAssistantThreadStarted(
    (event) => appSlackRuntime2.handleAssistantThreadStarted(event)
  );
  bot2.onAssistantContextChanged(
    (event) => appSlackRuntime2.handleAssistantContextChanged(event)
  );
  bot2.onSlashCommand(
    "/jr",
    (event) => withSpan(
      "workflow.slash_command",
      "workflow.slash_command",
      { slackUserId: event.user.userId },
      async () => {
        try {
          await handleSlashCommand(event);
        } catch (error) {
          logException(error, "slash_command_failed", { slackUserId: event.user.userId });
          throw error;
        }
      }
    )
  );
  bot2.onAppHomeOpened(
    (event) => withSpan(
      "workflow.app_home_opened",
      "workflow.app_home_opened",
      { slackUserId: event.userId },
      async () => {
        try {
          await publishAppHomeView(getSlackClient(), event.userId, getUserTokenStore());
        } catch (error) {
          logException(error, "app_home_opened_failed", { slackUserId: event.userId });
        }
      }
    )
  );
  bot2.onAction("app_home_disconnect", async (event) => {
    const provider = event.value;
    if (!provider) return;
    const userId = event.user.userId;
    await withSpan(
      "workflow.app_home_disconnect",
      "workflow.app_home_disconnect",
      { slackUserId: userId },
      async () => {
        try {
          await getUserTokenStore().delete(userId, provider);
          await publishAppHomeView(getSlackClient(), userId, getUserTokenStore());
        } catch (error) {
          logException(error, "app_home_disconnect_failed", { slackUserId: userId }, {
            "app.credential.provider": provider
          });
        }
      }
    );
  });
}

// src/chat/runtime/assistant-lifecycle.ts
import { ThreadImpl } from "chat";

// src/chat/slack-actions/types.ts
function coerceThreadArtifactsState(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const raw = value;
  const artifacts = raw.artifacts ?? {};
  const listColumnMap = artifacts.listColumnMap ?? {};
  const recentCanvases = [];
  if (Array.isArray(artifacts.recentCanvases)) {
    for (const entry of artifacts.recentCanvases) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const candidate = entry;
      if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
        continue;
      }
      recentCanvases.push({
        id: candidate.id,
        title: typeof candidate.title === "string" ? candidate.title : void 0,
        url: typeof candidate.url === "string" ? candidate.url : void 0,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : void 0
      });
    }
  }
  return {
    assistantContextChannelId: typeof artifacts.assistantContextChannelId === "string" ? artifacts.assistantContextChannelId : void 0,
    lastCanvasId: typeof artifacts.lastCanvasId === "string" ? artifacts.lastCanvasId : void 0,
    lastCanvasUrl: typeof artifacts.lastCanvasUrl === "string" ? artifacts.lastCanvasUrl : void 0,
    recentCanvases,
    lastListId: typeof artifacts.lastListId === "string" ? artifacts.lastListId : void 0,
    lastListUrl: typeof artifacts.lastListUrl === "string" ? artifacts.lastListUrl : void 0,
    listColumnMap: {
      titleColumnId: typeof listColumnMap.titleColumnId === "string" ? listColumnMap.titleColumnId : void 0,
      completedColumnId: typeof listColumnMap.completedColumnId === "string" ? listColumnMap.completedColumnId : void 0,
      assigneeColumnId: typeof listColumnMap.assigneeColumnId === "string" ? listColumnMap.assigneeColumnId : void 0,
      dueDateColumnId: typeof listColumnMap.dueDateColumnId === "string" ? listColumnMap.dueDateColumnId : void 0
    },
    updatedAt: typeof artifacts.updatedAt === "string" ? artifacts.updatedAt : void 0
  };
}
function buildArtifactStatePatch(patch) {
  return {
    artifacts: {
      ...patch,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}

// src/chat/configuration/validation.ts
var CONFIG_KEY_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
var SECRET_KEY_RE = /(?:^|[_.-])(token|secret|password|passphrase|api[-_]?key|private[-_]?key|credential|auth)(?:$|[_.-])/i;
var SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z\-_]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
];
function validateConfigKey(key) {
  const trimmed = key.trim();
  if (!trimmed) {
    return "Configuration key must not be empty";
  }
  if (!CONFIG_KEY_RE.test(trimmed)) {
    return `Invalid configuration key "${key}"; expected dotted lowercase namespace (for example "github.repo")`;
  }
  if (SECRET_KEY_RE.test(trimmed)) {
    return `Configuration key "${key}" appears to be secret-related and is not allowed`;
  }
  return void 0;
}
function collectStringValues(value, output, depth = 0) {
  if (depth > 5) {
    return;
  }
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      output.push(key);
      collectStringValues(nested, output, depth + 1);
    }
  }
}
function validateConfigValue(value) {
  const stringValues = [];
  collectStringValues(value, stringValues);
  for (const text of stringValues) {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(text)) {
        return "Configuration value appears to contain secret material and is not allowed";
      }
    }
  }
  return void 0;
}

// src/chat/configuration/service.ts
function isRecord(value) {
  return Boolean(value) && typeof value === "object";
}
function toOptionalString2(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function defaultState() {
  return {
    schemaVersion: 1,
    entries: {}
  };
}
function sanitizeEntry(value) {
  if (!isRecord(value)) {
    return void 0;
  }
  const key = toOptionalString2(value.key);
  if (!key) {
    return void 0;
  }
  if (validateConfigKey(key)) {
    return void 0;
  }
  const updatedAt = toOptionalString2(value.updatedAt);
  if (!updatedAt) {
    return void 0;
  }
  if (value.scope !== "channel" && value.scope !== "conversation") {
    return void 0;
  }
  const scope = "conversation";
  return {
    key,
    value: value.value,
    scope,
    updatedAt,
    updatedBy: toOptionalString2(value.updatedBy),
    source: toOptionalString2(value.source),
    expiresAt: toOptionalString2(value.expiresAt)
  };
}
function coerceState(raw) {
  if (!isRecord(raw)) {
    return defaultState();
  }
  const rawConfig = isRecord(raw.configuration) ? raw.configuration : {};
  const rawEntries = isRecord(rawConfig.entries) ? rawConfig.entries : {};
  const entries = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    const entry = sanitizeEntry(value);
    if (!entry) {
      continue;
    }
    entries[key] = entry;
  }
  return {
    schemaVersion: 1,
    entries
  };
}
function createChannelConfigurationService(storage) {
  const getState = async () => {
    const loaded = await storage.load();
    return coerceState(loaded);
  };
  const saveState = async (state) => {
    await storage.save({
      schemaVersion: 1,
      entries: state.entries
    });
  };
  const get = async (key) => {
    const normalizedKey = key.trim();
    const state = await getState();
    return state.entries[normalizedKey];
  };
  const set = async (input) => {
    const normalizedKey = input.key.trim();
    const keyError = validateConfigKey(normalizedKey);
    if (keyError) {
      throw new Error(keyError);
    }
    const valueError = validateConfigValue(input.value);
    if (valueError) {
      throw new Error(valueError);
    }
    const state = await getState();
    const nextEntry = {
      key: normalizedKey,
      value: input.value,
      scope: "conversation",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedBy: toOptionalString2(input.updatedBy),
      source: toOptionalString2(input.source),
      expiresAt: toOptionalString2(input.expiresAt)
    };
    state.entries[normalizedKey] = nextEntry;
    await saveState(state);
    return nextEntry;
  };
  const unset = async (key) => {
    const normalizedKey = key.trim();
    const state = await getState();
    if (!state.entries[normalizedKey]) {
      return false;
    }
    delete state.entries[normalizedKey];
    await saveState(state);
    return true;
  };
  const list = async (options = {}) => {
    const state = await getState();
    const prefix = options.prefix?.trim();
    return Object.values(state.entries).filter((entry) => prefix ? entry.key.startsWith(prefix) : true).sort((a, b) => a.key.localeCompare(b.key));
  };
  const resolve = async (key) => {
    const entry = await get(key);
    return entry?.value;
  };
  const resolveValues = async (options = {}) => {
    const keys = Array.isArray(options.keys) ? options.keys.map((entry) => entry.trim()).filter((entry) => entry.length > 0) : void 0;
    const entries = await list({
      ...options.prefix ? { prefix: options.prefix } : {}
    });
    const filtered = keys ? entries.filter((entry) => keys.includes(entry.key)) : entries;
    const resolved = {};
    for (const entry of filtered) {
      resolved[entry.key] = entry.value;
    }
    return resolved;
  };
  return {
    get,
    set,
    unset,
    list,
    resolve,
    resolveValues
  };
}

// src/chat/conversation-state.ts
function isRecord2(value) {
  return Boolean(value) && typeof value === "object";
}
function toOptionalString3(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function toOptionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function coerceRole(value) {
  return value === "assistant" || value === "system" || value === "user" ? value : "user";
}
function coerceAuthor(value) {
  if (!isRecord2(value)) return void 0;
  const author = {
    fullName: toOptionalString3(value.fullName),
    userId: toOptionalString3(value.userId),
    userName: toOptionalString3(value.userName)
  };
  if (typeof value.isBot === "boolean") {
    author.isBot = value.isBot;
  }
  if (!author.fullName && !author.userId && !author.userName && author.isBot === void 0) {
    return void 0;
  }
  return author;
}
function coerceMessageMeta(value) {
  if (!isRecord2(value)) return void 0;
  const meta = {};
  if (typeof value.explicitMention === "boolean") {
    meta.explicitMention = value.explicitMention;
  }
  if (typeof value.replied === "boolean") {
    meta.replied = value.replied;
  }
  if (typeof value.skippedReason === "string" && value.skippedReason.trim().length > 0) {
    meta.skippedReason = value.skippedReason;
  }
  if (typeof value.slackTs === "string" && value.slackTs.trim().length > 0) {
    meta.slackTs = value.slackTs;
  }
  if (Array.isArray(value.imageFileIds)) {
    const imageFileIds = value.imageFileIds.filter(
      (entry) => typeof entry === "string" && entry.trim().length > 0
    );
    if (imageFileIds.length > 0) {
      meta.imageFileIds = imageFileIds;
    }
  }
  if (typeof value.imagesHydrated === "boolean") {
    meta.imagesHydrated = value.imagesHydrated;
  }
  if (meta.explicitMention === void 0 && meta.replied === void 0 && meta.skippedReason === void 0 && meta.slackTs === void 0 && meta.imageFileIds === void 0 && meta.imagesHydrated === void 0) {
    return void 0;
  }
  return meta;
}
function defaultConversationState() {
  const nowMs = Date.now();
  return {
    schemaVersion: 1,
    messages: [],
    compactions: [],
    backfill: {},
    processing: {},
    stats: {
      estimatedContextTokens: 0,
      totalMessageCount: 0,
      compactedMessageCount: 0,
      updatedAtMs: nowMs
    },
    vision: {
      byFileId: {}
    }
  };
}
function coerceThreadConversationState(value) {
  if (!isRecord2(value)) {
    return defaultConversationState();
  }
  const root = value;
  const rawConversation = isRecord2(root.conversation) ? root.conversation : {};
  const base = defaultConversationState();
  const rawMessages = Array.isArray(rawConversation.messages) ? rawConversation.messages : [];
  const messages = [];
  for (const item of rawMessages) {
    if (!isRecord2(item)) continue;
    const id = toOptionalString3(item.id);
    const text = toOptionalString3(item.text);
    const createdAtMs = toOptionalNumber(item.createdAtMs);
    if (!id || !text || !createdAtMs) continue;
    messages.push({
      id,
      role: coerceRole(item.role),
      text,
      createdAtMs,
      author: coerceAuthor(item.author),
      meta: coerceMessageMeta(item.meta)
    });
  }
  const rawCompactions = Array.isArray(rawConversation.compactions) ? rawConversation.compactions : [];
  const compactions = [];
  for (const item of rawCompactions) {
    if (!isRecord2(item)) continue;
    const id = toOptionalString3(item.id);
    const summary = toOptionalString3(item.summary);
    const createdAtMs = toOptionalNumber(item.createdAtMs);
    if (!id || !summary || !createdAtMs) continue;
    const coveredMessageIds = Array.isArray(item.coveredMessageIds) ? item.coveredMessageIds.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
    compactions.push({
      id,
      summary,
      createdAtMs,
      coveredMessageIds
    });
  }
  const rawBackfill = isRecord2(rawConversation.backfill) ? rawConversation.backfill : {};
  const backfill = {
    completedAtMs: toOptionalNumber(rawBackfill.completedAtMs),
    source: rawBackfill.source === "recent_messages" || rawBackfill.source === "thread_fetch" ? rawBackfill.source : void 0
  };
  const rawProcessing = isRecord2(rawConversation.processing) ? rawConversation.processing : {};
  const processing = {
    activeTurnId: toOptionalString3(rawProcessing.activeTurnId),
    lastCompletedAtMs: toOptionalNumber(rawProcessing.lastCompletedAtMs)
  };
  const rawStats = isRecord2(rawConversation.stats) ? rawConversation.stats : {};
  const stats = {
    estimatedContextTokens: toOptionalNumber(rawStats.estimatedContextTokens) ?? base.stats.estimatedContextTokens,
    totalMessageCount: toOptionalNumber(rawStats.totalMessageCount) ?? messages.length,
    compactedMessageCount: toOptionalNumber(rawStats.compactedMessageCount) ?? 0,
    updatedAtMs: toOptionalNumber(rawStats.updatedAtMs) ?? base.stats.updatedAtMs
  };
  const rawVision = isRecord2(rawConversation.vision) ? rawConversation.vision : {};
  const rawVisionByFileId = isRecord2(rawVision.byFileId) ? rawVision.byFileId : {};
  const byFileId = {};
  for (const [fileId, value2] of Object.entries(rawVisionByFileId)) {
    if (typeof fileId !== "string" || fileId.trim().length === 0) continue;
    if (!isRecord2(value2)) continue;
    const summary = toOptionalString3(value2.summary);
    const analyzedAtMs = toOptionalNumber(value2.analyzedAtMs);
    if (!summary || !analyzedAtMs) continue;
    byFileId[fileId] = {
      summary,
      analyzedAtMs
    };
  }
  return {
    schemaVersion: 1,
    messages,
    compactions,
    backfill,
    processing,
    stats,
    vision: {
      backfillCompletedAtMs: toOptionalNumber(rawVision.backfillCompletedAtMs),
      byFileId
    }
  };
}
function buildConversationStatePatch(conversation) {
  return {
    conversation: {
      ...conversation,
      schemaVersion: 1,
      stats: {
        ...conversation.stats,
        totalMessageCount: conversation.messages.length,
        updatedAtMs: Date.now()
      }
    }
  };
}

// src/chat/runtime/thread-state.ts
function mergeArtifactsState(artifacts, patch) {
  if (!patch) {
    return artifacts;
  }
  return {
    ...artifacts,
    ...patch,
    listColumnMap: {
      ...artifacts.listColumnMap,
      ...patch.listColumnMap
    }
  };
}
async function persistThreadState(thread, patch) {
  const payload = {};
  if (patch.artifacts) {
    Object.assign(payload, buildArtifactStatePatch(patch.artifacts));
  }
  if (patch.conversation) {
    Object.assign(payload, buildConversationStatePatch(patch.conversation));
  }
  if (patch.sandboxId) {
    payload.app_sandbox_id = patch.sandboxId;
  }
  if (Object.keys(payload).length === 0) {
    return;
  }
  await thread.setState(payload);
}
function getChannelConfigurationService(thread) {
  const channel = thread.channel;
  return createChannelConfigurationService({
    load: async () => channel.state,
    save: async (state) => {
      await channel.setState({
        configuration: state
      });
    }
  });
}

// src/chat/runtime/assistant-lifecycle.ts
async function initializeAssistantThread(event) {
  const slack = event.getSlackAdapter();
  await slack.setAssistantTitle(event.channelId, event.threadTs, "Junior");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    { title: "Summarize thread", message: "Summarize the latest discussion in this thread." },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    { title: "Generate image", message: "Generate an image based on this conversation." }
  ]);
  if (!event.sourceChannelId) {
    return;
  }
  const thread = ThreadImpl.fromJSON({
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: event.channelId,
    id: event.threadId,
    isDM: event.channelId.startsWith("D")
  });
  const currentArtifacts = coerceThreadArtifactsState(await thread.state);
  const nextArtifacts = mergeArtifactsState(currentArtifacts, {
    assistantContextChannelId: event.sourceChannelId
  });
  await persistThreadState(thread, {
    artifacts: nextArtifacts
  });
}

// src/chat/slack-user.ts
var USER_CACHE_TTL_MS = 5 * 60 * 1e3;
var userCache = /* @__PURE__ */ new Map();
function readFromCache(userId) {
  const hit = userCache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    userCache.delete(userId);
    return null;
  }
  return hit.value;
}
function writeToCache(userId, value) {
  userCache.set(userId, {
    value,
    expiresAt: Date.now() + USER_CACHE_TTL_MS
  });
}
async function lookupSlackUser(userId) {
  if (!userId) {
    return null;
  }
  const cached = readFromCache(userId);
  if (cached) {
    return cached;
  }
  const token = getSlackBotToken();
  if (!token) {
    return null;
  }
  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      logWarn(
        "slack_user_lookup_failed",
        {},
        {
          "enduser.id": userId,
          "http.response.status_code": response.status
        },
        "Slack user lookup request failed"
      );
      return null;
    }
    const payload = await response.json();
    if (!payload.ok || !payload.user) {
      return null;
    }
    const userName = payload.user.name?.trim() || void 0;
    const fullName = payload.user.profile?.display_name?.trim() || payload.user.profile?.real_name?.trim() || payload.user.real_name?.trim() || void 0;
    const result = {
      userName,
      fullName
    };
    writeToCache(userId, result);
    return result;
  } catch (error) {
    logWarn(
      "slack_user_lookup_failed",
      {},
      {
        "enduser.id": userId,
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Slack user lookup failed with exception"
    );
    return null;
  }
}

// src/chat/runtime/deps.ts
var defaultBotDeps = {
  completeObject,
  completeText,
  downloadPrivateSlackFile,
  generateAssistantReply,
  listThreadReplies,
  lookupSlackUser
};
var botDeps = defaultBotDeps;
function setBotDepsForTests(overrides) {
  botDeps = {
    ...defaultBotDeps,
    ...overrides
  };
}
function resetBotDepsForTests() {
  botDeps = defaultBotDeps;
}
function getBotDeps() {
  return botDeps;
}

// src/chat/progress-reporter.ts
var STATUS_UPDATE_DEBOUNCE_MS = 1e3;
var STATUS_MIN_VISIBLE_MS = 1200;
function createProgressReporter(args) {
  const now = args.now ?? (() => Date.now());
  const setTimer = args.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = args.clearTimer ?? ((timer) => clearTimeout(timer));
  let active = false;
  let currentStatus = "";
  let lastStatusAt = 0;
  let pendingStatus = null;
  let pendingTimer = null;
  const postStatus = async (text) => {
    if (!args.channelId || !args.threadTs) {
      return;
    }
    currentStatus = text;
    lastStatusAt = now();
    try {
      await args.setAssistantStatus(args.channelId, args.threadTs, text, [text]);
    } catch {
    }
  };
  const clearPending = () => {
    if (pendingTimer) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
  };
  const flushPending = async () => {
    if (!active || !pendingStatus) {
      clearPending();
      return;
    }
    const next = pendingStatus;
    clearPending();
    if (next !== currentStatus) {
      await postStatus(next);
    }
  };
  return {
    async start() {
      active = true;
      clearPending();
      void postStatus("Thinking...");
    },
    async stop() {
      active = false;
      clearPending();
    },
    async setStatus(text) {
      const truncated = truncateStatusText(text);
      if (!active || !truncated || truncated === currentStatus || truncated === pendingStatus) {
        return;
      }
      const elapsed = now() - lastStatusAt;
      const waitMs = Math.max(
        STATUS_UPDATE_DEBOUNCE_MS - elapsed,
        STATUS_MIN_VISIBLE_MS - elapsed,
        0
      );
      if (waitMs <= 0) {
        clearPending();
        void postStatus(truncated);
        return;
      }
      pendingStatus = truncated;
      if (pendingTimer) {
        return;
      }
      pendingTimer = setTimer(() => {
        pendingTimer = null;
        void flushPending();
      }, Math.max(1, waitMs));
    }
  };
}

// src/chat/runtime/streaming.ts
function createTextStreamBridge() {
  const queue = [];
  let ended = false;
  let wakeConsumer = null;
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          wakeConsumer = resolve;
        });
      }
    }
  };
  return {
    iterable,
    push(delta) {
      if (!delta || ended) {
        return;
      }
      queue.push(delta);
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake?.();
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake?.();
    }
  };
}
function createNormalizingStream(inner, normalize) {
  return {
    async *[Symbol.asyncIterator]() {
      let accumulated = "";
      let emitted = 0;
      for await (const chunk of inner) {
        accumulated += chunk;
        const lastNewline = accumulated.lastIndexOf("\n");
        if (lastNewline === -1) {
          const delta2 = accumulated.slice(emitted);
          if (delta2) {
            yield delta2;
            emitted = accumulated.length;
          }
          continue;
        }
        const stable = accumulated.slice(0, lastNewline + 1);
        const normalized = normalize(stable);
        const delta = normalized.slice(emitted);
        emitted = normalized.length;
        if (delta) yield delta;
      }
      if (accumulated) {
        const normalized = normalize(accumulated);
        const delta = normalized.slice(emitted);
        if (delta) yield delta;
      }
    }
  };
}

// src/chat/slack-context.ts
function toOptionalString4(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function parseSlackThreadId(threadId) {
  const normalizedThreadId = toOptionalString4(threadId);
  if (!normalizedThreadId) {
    return void 0;
  }
  const parts = normalizedThreadId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack") {
    return void 0;
  }
  const channelId = toOptionalString4(parts[1]);
  const threadTs = toOptionalString4(parts[2]);
  if (!channelId || !threadTs) {
    return void 0;
  }
  return { channelId, threadTs };
}
function resolveSlackChannelIdFromThreadId(threadId) {
  return parseSlackThreadId(threadId)?.channelId;
}
function resolveSlackChannelIdFromMessage(message) {
  const messageChannelId = toOptionalString4(message.channelId);
  if (messageChannelId) {
    return messageChannelId;
  }
  const raw = message.raw;
  if (raw && typeof raw === "object") {
    const rawChannel = toOptionalString4(raw.channel);
    if (rawChannel) {
      return rawChannel;
    }
  }
  const threadId = toOptionalString4(message.threadId);
  return resolveSlackChannelIdFromThreadId(threadId);
}

// src/chat/runtime/thread-context.ts
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripLeadingBotMention(text, options = {}) {
  if (!text.trim()) return text;
  let next = text;
  if (options.stripLeadingSlackMentionToken) {
    next = next.replace(/^\s*<@[^>]+>[\s,:-]*/, "").trim();
  }
  const mentionByNameRe = new RegExp(`^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`, "i");
  next = next.replace(mentionByNameRe, "").trim();
  const mentionByLabeledEntityRe = new RegExp(
    `^\\s*<@[^>|]+\\|${escapeRegExp(botConfig.userName)}>[\\s,:-]*`,
    "i"
  );
  next = next.replace(mentionByLabeledEntityRe, "").trim();
  return next;
}
function getThreadId(thread, _message) {
  return toOptionalString(thread.id);
}
function getWorkflowRunId(thread, message) {
  return toOptionalString(thread.runId) ?? toOptionalString(message.runId);
}
function getChannelId(thread, message) {
  return thread.channelId ?? resolveSlackChannelIdFromMessage(message);
}
function getThreadTs(threadId) {
  return parseSlackThreadId(threadId)?.threadTs;
}
function getMessageTs(message) {
  const directTs = toOptionalString(message.ts);
  if (directTs) {
    return directTs;
  }
  const raw = message.raw;
  if (!raw || typeof raw !== "object") {
    return void 0;
  }
  const rawRecord = raw;
  return toOptionalString(rawRecord.ts) ?? toOptionalString(rawRecord.event_ts) ?? toOptionalString(rawRecord.message?.ts);
}
function getSlackApiErrorCode(error) {
  if (!error || typeof error !== "object") {
    return void 0;
  }
  const candidate = error;
  if (typeof candidate.data?.error === "string" && candidate.data.error.trim().length > 0) {
    return candidate.data.error;
  }
  if (typeof candidate.code === "string" && candidate.code.trim().length > 0) {
    return candidate.code;
  }
  return void 0;
}
function isSlackTitlePermissionError(error) {
  const code = getSlackApiErrorCode(error);
  return code === "no_permission" || code === "missing_scope" || code === "not_allowed_token_type";
}

// src/chat/services/conversation-memory.ts
var CONTEXT_COMPACTION_TRIGGER_TOKENS = 9e3;
var CONTEXT_COMPACTION_TARGET_TOKENS = 7e3;
var CONTEXT_MIN_LIVE_MESSAGES = 12;
var CONTEXT_COMPACTION_BATCH_SIZE = 24;
var CONTEXT_MAX_COMPACTIONS = 16;
var CONTEXT_MAX_MESSAGE_CHARS = 3200;
var BACKFILL_MESSAGE_LIMIT = 80;
function generateConversationId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function normalizeConversationText(text) {
  return text.trim().replace(/\s+/g, " ").slice(0, CONTEXT_MAX_MESSAGE_CHARS);
}
function estimateTokenCount(text) {
  return Math.ceil(text.length / 4);
}
function buildImageContextSuffix(message, conversation) {
  const byFileId = conversation?.vision.byFileId;
  const imageFileIds = message.meta?.imageFileIds ?? [];
  if (!byFileId || imageFileIds.length === 0) {
    return "";
  }
  const summaries = imageFileIds.map((fileId) => byFileId[fileId]?.summary?.trim()).filter((summary) => Boolean(summary));
  if (summaries.length === 0) {
    return "";
  }
  return ` [image context: ${summaries.join(" | ")}]`;
}
function renderConversationMessageLine(message, conversation) {
  const displayName = message.author?.fullName || message.author?.userName || (message.role === "assistant" ? botConfig.userName : message.role);
  const markers = [];
  if (message.meta?.replied === false) {
    markers.push(`assistant skipped: ${message.meta?.skippedReason ?? "no-reply route"}`);
  }
  if (message.meta?.explicitMention) {
    markers.push("explicit mention");
  }
  const markerSuffix = markers.length > 0 ? ` (${markers.join("; ")})` : "";
  const imageContext = buildImageContextSuffix(message, conversation);
  return `[${message.role}] ${displayName}: ${message.text}${imageContext}${markerSuffix}`;
}
function updateConversationStats(conversation) {
  const contextText = buildConversationContext(conversation);
  conversation.stats.estimatedContextTokens = estimateTokenCount(contextText ?? "");
  conversation.stats.totalMessageCount = conversation.messages.length;
  conversation.stats.updatedAtMs = Date.now();
}
function upsertConversationMessage(conversation, message) {
  const existingIndex = conversation.messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex >= 0) {
    conversation.messages[existingIndex] = {
      ...conversation.messages[existingIndex],
      ...message,
      meta: {
        ...conversation.messages[existingIndex]?.meta,
        ...message.meta
      }
    };
    updateConversationStats(conversation);
    return message.id;
  }
  conversation.messages.push(message);
  updateConversationStats(conversation);
  return message.id;
}
function markConversationMessage(conversation, messageId, patch) {
  if (!messageId) return;
  const messageIndex = conversation.messages.findIndex((entry) => entry.id === messageId);
  if (messageIndex < 0) return;
  const current = conversation.messages[messageIndex];
  conversation.messages[messageIndex] = {
    ...current,
    meta: {
      ...current.meta ?? {},
      ...patch
    }
  };
  updateConversationStats(conversation);
}
function buildConversationContext(conversation, options = {}) {
  const messages = conversation.messages.filter((entry) => entry.id !== options.excludeMessageId);
  if (messages.length === 0 && conversation.compactions.length === 0) {
    return void 0;
  }
  const lines = [];
  if (conversation.compactions.length > 0) {
    lines.push("<thread-compactions>");
    for (const [index, compaction] of conversation.compactions.entries()) {
      lines.push(
        [
          `summary_${index + 1}:`,
          compaction.summary,
          `covered_messages: ${compaction.coveredMessageIds.length}`,
          `created_at: ${new Date(compaction.createdAtMs).toISOString()}`
        ].join(" ")
      );
    }
    lines.push("</thread-compactions>");
    lines.push("");
  }
  lines.push("<thread-transcript>");
  for (const message of messages) {
    lines.push(renderConversationMessageLine(message, conversation));
  }
  lines.push("</thread-transcript>");
  return lines.join("\n");
}
function pruneCompactions(compactions) {
  if (compactions.length <= CONTEXT_MAX_COMPACTIONS) {
    return compactions;
  }
  const overflowCount = compactions.length - CONTEXT_MAX_COMPACTIONS + 1;
  const merged = compactions.slice(0, overflowCount);
  const mergedSummary = merged.map((entry) => entry.summary).join("\n").slice(0, 3500);
  const mergedIds = merged.flatMap((entry) => entry.coveredMessageIds).slice(0, 500);
  const compacted = {
    id: generateConversationId("compaction"),
    createdAtMs: Date.now(),
    summary: mergedSummary,
    coveredMessageIds: mergedIds
  };
  return [compacted, ...compactions.slice(overflowCount)];
}
async function summarizeConversationChunk(messages, conversation, context) {
  const transcript = messages.map((message) => renderConversationMessageLine(message, conversation)).join("\n");
  try {
    const result = await getBotDeps().completeText({
      modelId: botConfig.fastModelId,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            "Summarize the following older Slack thread transcript segment for future assistant turns.",
            "Keep the summary factual and concise.",
            "Preserve decisions, commitments, constraints, locations, hiring criteria, and unresolved asks.",
            "Do not invent details.",
            "",
            transcript
          ].join("\n"),
          timestamp: Date.now()
        }
      ],
      metadata: {
        modelId: botConfig.fastModelId,
        threadId: context.threadId ?? "",
        channelId: context.channelId ?? "",
        requesterId: context.requesterId ?? "",
        workflowRunId: context.workflowRunId ?? ""
      }
    });
    const summary = result.text.trim();
    if (summary.length > 0) {
      return summary.slice(0, 3500);
    }
  } catch (error) {
    logWarn(
      "conversation_compaction_summary_failed",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.fastModelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "app.compaction_messages_covered": messages.length
      },
      "Compaction summarization failed; using fallback summary"
    );
  }
  return transcript.slice(0, 2800);
}
async function generateThreadTitle(userText, assistantText) {
  const result = await getBotDeps().completeText({
    modelId: botConfig.fastModelId,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          "Generate a concise 5-8 word title for this conversation. Reply with ONLY the title, no quotes or punctuation.",
          "",
          `User: ${userText.slice(0, 500)}`,
          `Assistant: ${assistantText.slice(0, 500)}`
        ].join("\n"),
        timestamp: Date.now()
      }
    ]
  });
  return result.text.trim().slice(0, 60);
}
async function compactConversationIfNeeded(conversation, context) {
  updateConversationStats(conversation);
  let estimatedTokens = conversation.stats.estimatedContextTokens;
  setSpanAttributes({
    "app.context_tokens_estimated": estimatedTokens
  });
  while (estimatedTokens > CONTEXT_COMPACTION_TRIGGER_TOKENS && conversation.messages.length > CONTEXT_MIN_LIVE_MESSAGES) {
    const compactCount = Math.min(
      CONTEXT_COMPACTION_BATCH_SIZE,
      conversation.messages.length - CONTEXT_MIN_LIVE_MESSAGES
    );
    if (compactCount <= 0) {
      break;
    }
    const compactedChunk = conversation.messages.slice(0, compactCount);
    const summary = await summarizeConversationChunk(compactedChunk, conversation, context);
    conversation.compactions.push({
      id: generateConversationId("compaction"),
      createdAtMs: Date.now(),
      summary,
      coveredMessageIds: compactedChunk.map((entry) => entry.id)
    });
    conversation.compactions = pruneCompactions(conversation.compactions);
    conversation.messages = conversation.messages.slice(compactCount);
    conversation.stats.compactedMessageCount += compactCount;
    updateConversationStats(conversation);
    estimatedTokens = conversation.stats.estimatedContextTokens;
    setSpanAttributes({
      "app.compaction_messages_covered": compactCount,
      "app.context_tokens_estimated": estimatedTokens
    });
    if (estimatedTokens <= CONTEXT_COMPACTION_TARGET_TOKENS) {
      break;
    }
  }
}
function createConversationMessageFromSdkMessage(entry) {
  const rawText = normalizeConversationText(entry.text);
  if (!rawText) {
    return null;
  }
  return {
    id: entry.id,
    role: entry.author.isMe ? "assistant" : "user",
    text: rawText,
    createdAtMs: entry.metadata.dateSent.getTime(),
    author: {
      userId: entry.author.userId,
      userName: entry.author.userName,
      fullName: entry.author.fullName,
      isBot: typeof entry.author.isBot === "boolean" ? entry.author.isBot : void 0
    },
    meta: {
      slackTs: entry.id
    }
  };
}
async function seedConversationBackfill(thread, conversation, currentTurn) {
  if (conversation.backfill.completedAtMs) {
    return;
  }
  if (conversation.messages.length > 0 || conversation.compactions.length > 0) {
    conversation.backfill = {
      completedAtMs: Date.now(),
      source: "recent_messages"
    };
    updateConversationStats(conversation);
    return;
  }
  const seeded = [];
  let source = "recent_messages";
  try {
    const fetchedNewestFirst = [];
    for await (const entry of thread.messages) {
      fetchedNewestFirst.push(entry);
      if (fetchedNewestFirst.length >= BACKFILL_MESSAGE_LIMIT) {
        break;
      }
    }
    fetchedNewestFirst.reverse();
    for (const entry of fetchedNewestFirst) {
      const message = createConversationMessageFromSdkMessage(entry);
      if (message) {
        seeded.push(message);
      }
    }
    if (seeded.length > 0) {
      source = "thread_fetch";
    }
  } catch {
  }
  if (seeded.length === 0) {
    try {
      await thread.refresh();
    } catch {
    }
    const fromRecent = thread.recentMessages.slice(-BACKFILL_MESSAGE_LIMIT);
    for (const entry of fromRecent) {
      const message = createConversationMessageFromSdkMessage(entry);
      if (message) {
        seeded.push(message);
      }
    }
    source = "recent_messages";
  }
  for (const message of seeded) {
    if (message.id !== currentTurn.messageId && message.createdAtMs > currentTurn.messageCreatedAtMs) {
      continue;
    }
    if (message.id !== currentTurn.messageId && message.createdAtMs === currentTurn.messageCreatedAtMs && message.id > currentTurn.messageId) {
      continue;
    }
    upsertConversationMessage(conversation, message);
  }
  conversation.backfill = {
    completedAtMs: Date.now(),
    source
  };
  updateConversationStats(conversation);
}
function isHumanConversationMessage(message) {
  return message.role === "user" && message.author?.isBot !== true;
}
function getConversationMessageSlackTs(message) {
  return message.meta?.slackTs ?? toOptionalString(message.id);
}

// src/chat/services/vision-context.ts
var MAX_USER_ATTACHMENTS = 3;
var MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
var MAX_MESSAGE_IMAGE_ATTACHMENTS = 3;
var MAX_VISION_SUMMARY_CHARS = 500;
async function resolveUserAttachments(attachments, context) {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const results = [];
  for (const attachment of attachments) {
    if (results.length >= MAX_USER_ATTACHMENTS) break;
    if (attachment.type !== "image" && attachment.type !== "file") continue;
    const mediaType = attachment.mimeType ?? "application/octet-stream";
    try {
      let data = null;
      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.data instanceof Buffer) {
        data = attachment.data;
      }
      if (!data) continue;
      if (data.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "attachment_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.size": data.byteLength,
            "file.mime_type": mediaType
          },
          "Skipping user attachment that exceeds size limit"
        );
        continue;
      }
      results.push({
        data,
        mediaType,
        filename: attachment.name
      });
    } catch (error) {
      logWarn(
        "attachment_resolution_failed",
        {
          slackThreadId: context.threadId,
          slackUserId: context.requesterId,
          slackChannelId: context.channelId,
          workflowRunId: context.workflowRunId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId
        },
        {
          "error.message": error instanceof Error ? error.message : String(error),
          "file.mime_type": mediaType
        },
        "Failed to resolve user attachment"
      );
    }
  }
  return results;
}
async function summarizeConversationImage(args) {
  try {
    const result = await getBotDeps().completeText({
      modelId: botConfig.modelId,
      temperature: 0,
      maxTokens: 220,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extract concise, factual context from this image for future thread turns.",
                "Focus on visible text, names, titles, companies, and candidate-identifying details.",
                "Do not speculate.",
                "Return plain text only."
              ].join(" ")
            },
            {
              type: "image",
              data: args.imageData.toString("base64"),
              mimeType: args.mimeType
            }
          ],
          timestamp: Date.now()
        }
      ],
      metadata: {
        modelId: botConfig.modelId,
        threadId: args.context.threadId ?? "",
        channelId: args.context.channelId ?? "",
        requesterId: args.context.requesterId ?? "",
        workflowRunId: args.context.workflowRunId ?? "",
        fileId: args.fileId
      }
    });
    const summary = result.text.trim().replace(/\s+/g, " ");
    if (!summary) {
      return void 0;
    }
    return summary.slice(0, MAX_VISION_SUMMARY_CHARS);
  } catch (error) {
    logWarn(
      "conversation_image_vision_failed",
      {
        slackThreadId: args.context.threadId,
        slackUserId: args.context.requesterId,
        slackChannelId: args.context.channelId,
        workflowRunId: args.context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "file.id": args.fileId,
        "file.mime_type": args.mimeType
      },
      "Image analysis failed while hydrating conversation context"
    );
    return void 0;
  }
}
async function hydrateConversationVisionContext(conversation, context) {
  if (!context.channelId || !context.threadTs) {
    return;
  }
  const messagesByTs = /* @__PURE__ */ new Map();
  for (const message of conversation.messages) {
    if (!isHumanConversationMessage(message)) continue;
    if (message.meta?.imagesHydrated) continue;
    const slackTs = getConversationMessageSlackTs(message);
    if (!slackTs) continue;
    messagesByTs.set(slackTs, message);
  }
  if (messagesByTs.size === 0) {
    return;
  }
  let replies;
  try {
    replies = await getBotDeps().listThreadReplies({
      channelId: context.channelId,
      threadTs: context.threadTs,
      limit: 1e3,
      maxPages: 10,
      targetMessageTs: [...messagesByTs.keys()]
    });
  } catch (error) {
    logWarn(
      "conversation_image_replies_fetch_failed",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Failed to fetch thread replies for image context hydration"
    );
    return;
  }
  let cacheHits = 0;
  let cacheMisses = 0;
  let analyzed = 0;
  let mutated = false;
  const hydratedMessageIds = /* @__PURE__ */ new Set();
  for (const reply of replies) {
    const ts = toOptionalString(reply.ts);
    if (!ts || reply.bot_id || reply.subtype === "bot_message") {
      continue;
    }
    const conversationMessage = messagesByTs.get(ts);
    if (!conversationMessage) {
      continue;
    }
    hydratedMessageIds.add(conversationMessage.id);
    const imageFiles = (reply.files ?? []).filter((file) => {
      const mimeType = toOptionalString(file.mimetype);
      return Boolean(toOptionalString(file.id) && mimeType?.startsWith("image/"));
    }).slice(0, MAX_MESSAGE_IMAGE_ATTACHMENTS);
    if (imageFiles.length === 0) {
      continue;
    }
    const imageFileIds = imageFiles.map((file) => toOptionalString(file.id)).filter((fileId) => Boolean(fileId));
    const existingMeta = conversationMessage.meta ?? {};
    conversationMessage.meta = {
      ...existingMeta,
      slackTs: existingMeta.slackTs ?? ts,
      imageFileIds,
      imagesHydrated: true
    };
    mutated = true;
    for (const file of imageFiles) {
      const fileId = toOptionalString(file.id);
      if (!fileId) continue;
      if (conversation.vision.byFileId[fileId]) {
        cacheHits += 1;
        continue;
      }
      cacheMisses += 1;
      const mimeType = toOptionalString(file.mimetype) ?? "application/octet-stream";
      const fileSize = typeof file.size === "number" && Number.isFinite(file.size) ? file.size : void 0;
      if (fileSize && fileSize > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.id": fileId,
            "file.size": fileSize,
            "file.mime_type": mimeType
          },
          "Skipping thread image that exceeds size limit"
        );
        continue;
      }
      const downloadUrl = toOptionalString(file.url_private_download) ?? toOptionalString(file.url_private);
      if (!downloadUrl) {
        continue;
      }
      let imageData;
      try {
        imageData = await getBotDeps().downloadPrivateSlackFile(downloadUrl);
      } catch (error) {
        logWarn(
          "conversation_image_download_failed",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "error.message": error instanceof Error ? error.message : String(error),
            "file.id": fileId,
            "file.mime_type": mimeType
          },
          "Failed to download thread image for context hydration"
        );
        continue;
      }
      if (imageData.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.id": fileId,
            "file.size": imageData.byteLength,
            "file.mime_type": mimeType
          },
          "Skipping downloaded thread image that exceeds size limit"
        );
        continue;
      }
      const summary = await summarizeConversationImage({
        imageData,
        mimeType,
        fileId,
        context
      });
      if (!summary) {
        continue;
      }
      conversation.vision.byFileId[fileId] = {
        summary,
        analyzedAtMs: Date.now()
      };
      analyzed += 1;
      mutated = true;
    }
  }
  if (mutated) {
    updateConversationStats(conversation);
  }
  if (cacheHits > 0 || cacheMisses > 0 || analyzed > 0 || hydratedMessageIds.size > 0) {
    logInfo(
      "conversation_image_context_hydrated",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "app.conversation_image.cache_hits": cacheHits,
        "app.conversation_image.cache_misses": cacheMisses,
        "app.conversation_image.analyzed": analyzed,
        "app.conversation_image.messages_hydrated": hydratedMessageIds.size
      },
      "Hydrated conversation image context"
    );
  }
  if (!conversation.vision.backfillCompletedAtMs) {
    conversation.vision.backfillCompletedAtMs = Date.now();
  }
}

// src/chat/turn/execute.ts
function resolveReplyDelivery(args) {
  const replyHasFiles = Boolean(args.reply.files && args.reply.files.length > 0);
  const deliveryPlan = args.reply.deliveryPlan ?? {
    mode: args.reply.deliveryMode ?? "thread",
    ack: args.reply.ackStrategy ?? "none",
    postThreadText: (args.reply.deliveryMode ?? "thread") !== "channel_only",
    attachFiles: replyHasFiles ? args.hasStreamedThreadReply ? "followup" : "inline" : "none"
  };
  let attachFiles = deliveryPlan.attachFiles;
  if (attachFiles === "followup" && !args.hasStreamedThreadReply) {
    attachFiles = "inline";
  }
  return {
    shouldPostThreadReply: deliveryPlan.postThreadText,
    attachFiles
  };
}

// src/chat/turn/persist.ts
function markTurnCompleted(args) {
  args.conversation.processing.activeTurnId = void 0;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.updateConversationStats(args.conversation);
}
function markTurnFailed(args) {
  args.conversation.processing.activeTurnId = void 0;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "reply failed"
  });
  args.updateConversationStats(args.conversation);
}

// src/chat/turn/prepare.ts
function startActiveTurn(args) {
  args.conversation.processing.activeTurnId = args.nextTurnId;
  args.updateConversationStats(args.conversation);
}

// src/chat/runtime/reply-executor.ts
function createReplyToThread(deps) {
  return async function replyToThread2(thread, message, options = {}) {
    if (message.author.isMe) {
      return;
    }
    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(thread, message);
    const threadTs = getThreadTs(threadId);
    const messageTs = getMessageTs(message);
    const workflowRunId = getWorkflowRunId(thread, message);
    await withSpan(
      "workflow.reply",
      "workflow.reply",
      {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      async () => {
        const userText = stripLeadingBotMention(message.text, {
          stripLeadingSlackMentionToken: options.explicitMention || Boolean(message.isMention)
        });
        const explicitChannelPostIntent = isExplicitChannelPostIntent(userText);
        const preparedState = options.preparedState ?? await deps.prepareTurnState({
          thread,
          message,
          userText,
          explicitMention: Boolean(options.explicitMention || message.isMention),
          context: {
            threadId,
            requesterId: message.author.userId,
            channelId,
            workflowRunId
          }
        });
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: generateConversationId("turn"),
          updateConversationStats
        });
        await persistThreadState(thread, {
          conversation: preparedState.conversation
        });
        const fallbackIdentity = await getBotDeps().lookupSlackUser(message.author.userId);
        const resolvedUserName = message.author.userName ?? fallbackIdentity?.userName;
        if (resolvedUserName) {
          setTags({ slackUserName: resolvedUserName });
        }
        const userAttachments = await resolveUserAttachments(message.attachments, {
          threadId,
          requesterId: message.author.userId,
          channelId,
          workflowRunId
        });
        const progress = createProgressReporter({
          channelId,
          threadTs,
          setAssistantStatus: (channel, thread2, text, suggestions) => deps.getSlackAdapter().setAssistantStatus(channel, thread2, text, suggestions)
        });
        const textStream = createTextStreamBridge();
        let streamedReplyPromise;
        const startStreamingReply = () => {
          if (!streamedReplyPromise) {
            streamedReplyPromise = thread.post(
              createNormalizingStream(textStream.iterable, ensureBlockSpacing)
            );
          }
        };
        await progress.start();
        let persistedAtLeastOnce = false;
        try {
          const toolChannelId = preparedState.artifacts.assistantContextChannelId ?? channelId;
          const reply = await getBotDeps().generateAssistantReply(userText, {
            assistant: {
              userName: botConfig.userName
            },
            requester: {
              userId: message.author.userId,
              userName: message.author.userName ?? fallbackIdentity?.userName,
              fullName: message.author.fullName ?? fallbackIdentity?.fullName
            },
            conversationContext: preparedState.routingContext ?? preparedState.conversationContext,
            artifactState: preparedState.artifacts,
            configuration: preparedState.configuration,
            channelConfiguration: preparedState.channelConfiguration,
            userAttachments,
            correlation: {
              threadId,
              threadTs,
              messageTs,
              workflowRunId,
              channelId,
              requesterId: message.author.userId
            },
            toolChannelId,
            sandbox: {
              sandboxId: preparedState.sandboxId
            },
            onStatus: (status) => progress.setStatus(status),
            onTextDelta: (deltaText) => {
              if (explicitChannelPostIntent) {
                return;
              }
              startStreamingReply();
              textStream.push(deltaText);
            }
          });
          textStream.end();
          const diagnosticsContext = {
            slackThreadId: threadId,
            slackUserId: message.author.userId,
            slackChannelId: channelId,
            workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          };
          const diagnosticsAttributes = {
            "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
            "gen_ai.operation.name": "invoke_agent",
            "app.ai.outcome": reply.diagnostics.outcome,
            "app.ai.assistant_messages": reply.diagnostics.assistantMessageCount,
            "app.ai.tool_results": reply.diagnostics.toolResultCount,
            "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
            "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
            "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
            ...reply.diagnostics.stopReason ? { "app.ai.stop_reason": reply.diagnostics.stopReason } : {},
            ...reply.diagnostics.errorMessage ? { "error.message": reply.diagnostics.errorMessage } : {}
          };
          setSpanAttributes(diagnosticsAttributes);
          if (reply.diagnostics.outcome === "provider_error") {
            const providerError = reply.diagnostics.providerError ?? new Error(reply.diagnostics.errorMessage ?? "Provider error without explicit message");
            logException(
              providerError,
              "agent_turn_provider_error",
              diagnosticsContext,
              diagnosticsAttributes,
              "Agent turn failed with provider error"
            );
          } else if (reply.diagnostics.outcome !== "success") {
            logWarn(
              "agent_turn_diagnostics",
              diagnosticsContext,
              diagnosticsAttributes,
              "Agent turn completed with execution failure"
            );
          }
          markConversationMessage(preparedState.conversation, preparedState.userMessageId, {
            replied: true,
            skippedReason: void 0
          });
          upsertConversationMessage(preparedState.conversation, {
            id: generateConversationId("assistant"),
            role: "assistant",
            text: normalizeConversationText(reply.text) || "[empty response]",
            createdAtMs: Date.now(),
            author: {
              userName: botConfig.userName,
              isBot: true
            },
            meta: {
              replied: true
            }
          });
          const artifactStatePatch = reply.artifactStatePatch ? { ...reply.artifactStatePatch } : {};
          const replyFiles = reply.files && reply.files.length > 0 ? reply.files : void 0;
          const { shouldPostThreadReply, attachFiles: resolvedAttachFiles } = resolveReplyDelivery({
            reply,
            hasStreamedThreadReply: Boolean(streamedReplyPromise)
          });
          if (shouldPostThreadReply) {
            if (!streamedReplyPromise) {
              await thread.post(
                buildSlackOutputMessage(reply.text, {
                  files: resolvedAttachFiles === "inline" ? replyFiles : void 0
                })
              );
            } else {
              await streamedReplyPromise;
              if (reply.diagnostics.outcome !== "success" && reply.text.trim().length > 0) {
                await thread.post(buildSlackOutputMessage(reply.text));
              }
            }
          }
          const shouldPersistArtifacts = Object.keys(artifactStatePatch).length > 0;
          const nextArtifacts = shouldPersistArtifacts ? mergeArtifactsState(preparedState.artifacts, artifactStatePatch) : void 0;
          markTurnCompleted({
            conversation: preparedState.conversation,
            nowMs: Date.now(),
            updateConversationStats
          });
          await persistThreadState(thread, {
            artifacts: nextArtifacts,
            conversation: preparedState.conversation,
            sandboxId: reply.sandboxId
          });
          persistedAtLeastOnce = true;
          const isFirstAssistantReply = preparedState.conversation.stats.compactedMessageCount === 0 && preparedState.conversation.messages.filter((m) => m.role === "assistant").length === 1;
          if (isFirstAssistantReply && channelId && isDmChannel(channelId) && threadTs) {
            void generateThreadTitle(userText, reply.text).then((title) => deps.getSlackAdapter().setAssistantTitle(channelId, threadTs, title)).catch((error) => {
              const slackErrorCode = getSlackApiErrorCode(error);
              if (isSlackTitlePermissionError(error)) {
                setSpanAttributes({
                  "app.slack.assistant_title.outcome": "permission_denied",
                  ...slackErrorCode ? { "app.slack.assistant_title.error_code": slackErrorCode } : {}
                });
                return;
              }
              logWarn(
                "thread_title_generation_failed",
                {
                  slackThreadId: threadId,
                  slackUserId: message.author.userId,
                  slackChannelId: channelId,
                  workflowRunId,
                  assistantUserName: botConfig.userName,
                  modelId: botConfig.fastModelId
                },
                { "error.message": error instanceof Error ? error.message : String(error) },
                "Thread title generation failed"
              );
            });
          }
          if (shouldPostThreadReply && resolvedAttachFiles === "followup" && replyFiles) {
            await thread.post({ files: replyFiles });
          }
        } finally {
          textStream.end();
          if (!persistedAtLeastOnce) {
            markTurnFailed({
              conversation: preparedState.conversation,
              nowMs: Date.now(),
              userMessageId: preparedState.userMessageId,
              markConversationMessage: (conversation, messageId, patch) => {
                markConversationMessage(conversation, messageId, patch);
              },
              updateConversationStats
            });
            await persistThreadState(thread, {
              conversation: preparedState.conversation
            });
          }
          await progress.stop();
        }
      }
    );
  };
}

// src/chat/routing/subscribed-decision.ts
import { z } from "zod";
var replyDecisionSchema = z.object({
  should_reply: z.boolean().describe("Whether Junior should respond to this thread message."),
  confidence: z.number().min(0).max(1).describe("Classifier confidence from 0 to 1."),
  reason: z.string().max(160).optional().describe("Short reason for the decision.")
});
var ROUTER_CONFIDENCE_THRESHOLD = 0.72;
var ACK_REGEXES = [
  /^(thanks|thank you|thx|ty|tysm|much appreciated)[!. ]*$/i,
  /^(ok|okay|k|got it|sgtm|lgtm|sounds good|works for me|works|done|resolved|perfect|great|nice|cool)[!. ]*$/i,
  /^(\+1|\+\+|ack|roger|copy that)[!. ]*$/i,
  /^(:[a-z0-9_+-]+:|[\p{Extended_Pictographic}\uFE0F\u200D])+[!. ]*$/u
];
var QUESTION_PREFIX_RE = /^(what|why|how|when|where|which|who|can|could|would|should|do|does|did|is|are|was|were|will)\b/i;
var FOLLOW_UP_REF_RE = /\b(you|your|that|this|it|above|previous|earlier|last|just\s+said)\b/i;
function tokenizeForOverlap(value) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
}
function getLastAssistantLine(conversationContext) {
  if (!conversationContext) return void 0;
  const lines = conversationContext.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith("[assistant]")) {
      return line;
    }
  }
  return void 0;
}
function isLikelyAcknowledgment(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("?")) return false;
  for (const regex of ACK_REGEXES) {
    if (regex.test(trimmed)) {
      return true;
    }
  }
  return false;
}
function isLikelyAssistantDirectedFollowUp(text, conversationContext) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const isQuestion = trimmed.includes("?") || QUESTION_PREFIX_RE.test(trimmed);
  if (!isQuestion) {
    return false;
  }
  const lastAssistantLine = getLastAssistantLine(conversationContext);
  if (!lastAssistantLine) {
    return false;
  }
  if (FOLLOW_UP_REF_RE.test(trimmed)) {
    return true;
  }
  const questionTokens = tokenizeForOverlap(trimmed);
  const assistantTokens = new Set(tokenizeForOverlap(lastAssistantLine));
  for (const token of questionTokens) {
    if (assistantTokens.has(token)) {
      return true;
    }
  }
  return false;
}
function buildRouterSystemPrompt(botUserName, conversationContext) {
  return [
    "You are a message router for a Slack assistant named Junior in a subscribed Slack thread.",
    "Decide whether Junior should reply to the latest message.",
    "Default to should_reply=false unless the user is clearly asking Junior for help or follow-up.",
    "",
    "Reply should be true only when the user is clearly asking Junior a question, requesting help,",
    "or when a direct follow-up is contextually aimed at Junior's previous response in the thread context.",
    "",
    "Reply should be false for side conversations between humans, acknowledgements (thanks, +1),",
    "status chatter, or messages not seeking assistant input.",
    "Junior must not participate in casual banter.",
    "If uncertain, set should_reply=false and use low confidence.",
    "",
    "Return JSON with should_reply, confidence, and a short reason. Do not return any extra keys.",
    "",
    `<assistant-name>${escapeXml(botUserName)}</assistant-name>`,
    `<thread-context>${escapeXml(conversationContext?.trim() || "[none]")}</thread-context>`
  ].join("\n");
}
async function decideSubscribedThreadReply(args) {
  const text = args.input.text.trim();
  const rawText = args.input.rawText.trim();
  if (args.input.isExplicitMention) {
    return { shouldReply: true, reason: "explicit_mention" /* ExplicitMention */ };
  }
  if (!text && !args.input.hasAttachments) {
    return { shouldReply: false, reason: "empty_message" /* EmptyMessage */ };
  }
  if (!text && args.input.hasAttachments) {
    return { shouldReply: true, reason: "attachment_only" /* AttachmentOnly */ };
  }
  if (isLikelyAcknowledgment(text)) {
    return { shouldReply: false, reason: "acknowledgment" /* Acknowledgment */ };
  }
  if (isLikelyAssistantDirectedFollowUp(text, args.input.conversationContext)) {
    return { shouldReply: true, reason: "follow_up_question" /* FollowUpQuestion */ };
  }
  try {
    const result = await args.completeObject({
      modelId: args.modelId,
      schema: replyDecisionSchema,
      maxTokens: 120,
      temperature: 0,
      system: buildRouterSystemPrompt(args.botUserName, args.input.conversationContext),
      prompt: rawText,
      metadata: {
        modelId: args.modelId,
        threadId: args.input.context.threadId ?? "",
        channelId: args.input.context.channelId ?? "",
        requesterId: args.input.context.requesterId ?? "",
        workflowRunId: args.input.context.workflowRunId ?? ""
      }
    });
    const parsed = replyDecisionSchema.parse(result.object);
    const reason = parsed.reason?.trim() || "classifier";
    if (!parsed.should_reply) {
      return {
        shouldReply: false,
        reason: "side_conversation" /* SideConversation */,
        reasonDetail: reason
      };
    }
    if (parsed.confidence < ROUTER_CONFIDENCE_THRESHOLD) {
      return {
        shouldReply: false,
        reason: "low_confidence" /* LowConfidence */,
        reasonDetail: `${parsed.confidence.toFixed(2)}: ${reason}`
      };
    }
    return {
      shouldReply: true,
      reason: "llm_classifier" /* Classifier */,
      reasonDetail: reason
    };
  } catch (error) {
    args.logClassifierFailure(error, args.input);
    return {
      shouldReply: false,
      reason: "classifier_error" /* ClassifierError */
    };
  }
}

// src/chat/runtime/subscribed-routing.ts
async function shouldReplyInSubscribedThread(args) {
  const decision = await decideSubscribedThreadReply({
    botUserName: botConfig.userName,
    modelId: botConfig.fastModelId,
    input: args,
    completeObject: (input) => getBotDeps().completeObject(input),
    logClassifierFailure: (error, input) => {
      logWarn(
        "subscribed_reply_classifier_failed",
        {
          slackThreadId: input.context.threadId,
          slackUserId: input.context.requesterId,
          slackChannelId: input.context.channelId,
          workflowRunId: input.context.workflowRunId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.fastModelId
        },
        {
          "error.message": error instanceof Error ? error.message : String(error)
        },
        "Subscribed-thread reply classifier failed; skipping reply"
      );
    }
  });
  const reason = decision.reasonDetail ? `${decision.reason}:${decision.reasonDetail}` : decision.reason;
  return {
    shouldReply: decision.shouldReply,
    reason
  };
}

// src/chat/runtime/turn-preparation.ts
async function prepareTurnState(args) {
  const existingState = await args.thread.state;
  const existingSandboxId = existingState ? toOptionalString(existingState.app_sandbox_id) : void 0;
  const artifacts = coerceThreadArtifactsState(existingState);
  const conversation = coerceThreadConversationState(existingState);
  const channelConfiguration = getChannelConfigurationService(args.thread);
  const configuration = await channelConfiguration.resolveValues();
  await seedConversationBackfill(args.thread, conversation, {
    messageId: args.message.id,
    messageCreatedAtMs: args.message.metadata.dateSent.getTime()
  });
  const messageHasPotentialImageAttachment = args.message.attachments.some((attachment) => {
    if (attachment.type === "image") {
      return true;
    }
    const mimeType = attachment.mimeType ?? "";
    return attachment.type === "file" && mimeType.startsWith("image/");
  });
  const normalizedUserText = normalizeConversationText(args.userText) || "[non-text message]";
  const incomingUserMessage = {
    id: args.message.id,
    role: "user",
    text: normalizedUserText,
    createdAtMs: args.message.metadata.dateSent.getTime(),
    author: {
      userId: args.message.author.userId,
      userName: args.message.author.userName,
      fullName: args.message.author.fullName,
      isBot: typeof args.message.author.isBot === "boolean" ? args.message.author.isBot : void 0
    },
    meta: {
      explicitMention: args.explicitMention,
      slackTs: args.message.id,
      imagesHydrated: !messageHasPotentialImageAttachment
    }
  };
  const userMessageId = upsertConversationMessage(conversation, incomingUserMessage);
  if (messageHasPotentialImageAttachment || !conversation.vision.backfillCompletedAtMs) {
    await hydrateConversationVisionContext(conversation, {
      threadId: args.context.threadId,
      channelId: args.context.channelId,
      requesterId: args.context.requesterId,
      workflowRunId: args.context.workflowRunId,
      threadTs: getThreadTs(args.context.threadId)
    });
  }
  await compactConversationIfNeeded(conversation, {
    threadId: args.context.threadId,
    channelId: args.context.channelId,
    requesterId: args.context.requesterId,
    workflowRunId: args.context.workflowRunId
  });
  const conversationContext = buildConversationContext(conversation);
  const routingContext = buildConversationContext(conversation, {
    excludeMessageId: userMessageId
  });
  setSpanAttributes({
    "app.backfill_source": conversation.backfill.source ?? "none",
    "app.context_tokens_estimated": conversation.stats.estimatedContextTokens
  });
  return {
    artifacts,
    configuration,
    channelConfiguration,
    conversation,
    sandboxId: existingSandboxId,
    conversationContext,
    routingContext,
    userMessageId
  };
}

// src/chat/bot.ts
var createdBot = new Chat2({
  userName: botConfig.userName,
  adapters: {
    slack: (() => {
      const signingSecret = getSlackSigningSecret();
      const botToken = getSlackBotToken();
      const clientId = getSlackClientId();
      const clientSecret = getSlackClientSecret();
      if (!signingSecret) {
        throw new Error("SLACK_SIGNING_SECRET is required");
      }
      return createSlackAdapter({
        signingSecret,
        ...botToken ? { botToken } : {},
        ...clientId ? { clientId } : {},
        ...clientSecret ? { clientSecret } : {}
      });
    })()
  },
  state: getStateAdapter()
});
var registerSingleton = createdBot.registerSingleton;
if (typeof registerSingleton === "function") {
  registerSingleton.call(createdBot);
}
var bot = createdBot;
function getSlackAdapter() {
  return bot.getAdapter("slack");
}
var replyToThread = createReplyToThread({
  getSlackAdapter,
  prepareTurnState
});
var appSlackRuntime = createAppSlackRuntime({
  assistantUserName: botConfig.userName,
  modelId: botConfig.modelId,
  now: () => Date.now(),
  getThreadId,
  getChannelId,
  getWorkflowRunId,
  stripLeadingBotMention,
  withSpan,
  logWarn,
  logException,
  prepareTurnState,
  persistPreparedState: async ({ thread, preparedState }) => {
    await persistThreadState(thread, {
      conversation: preparedState.conversation
    });
  },
  getPreparedConversationContext: (preparedState) => preparedState.routingContext ?? preparedState.conversationContext,
  shouldReplyInSubscribedThread,
  onSubscribedMessageSkipped: async ({ thread, preparedState, decision, completedAtMs }) => {
    markConversationMessage(preparedState.conversation, preparedState.userMessageId, {
      replied: false,
      skippedReason: decision.reason
    });
    preparedState.conversation.processing.activeTurnId = void 0;
    preparedState.conversation.processing.lastCompletedAtMs = completedAtMs;
    updateConversationStats(preparedState.conversation);
    await persistThreadState(thread, {
      conversation: preparedState.conversation
    });
  },
  replyToThread,
  initializeAssistantThread: async ({ threadId, channelId, threadTs, sourceChannelId }) => {
    await initializeAssistantThread({
      threadId,
      channelId,
      threadTs,
      sourceChannelId,
      getSlackAdapter
    });
  }
});
registerBotHandlers({
  bot,
  appSlackRuntime
});
export {
  appSlackRuntime,
  bot,
  createNormalizingStream,
  resetBotDepsForTests,
  setBotDepsForTests
};
