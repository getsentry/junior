import type { Message, SentMessage, Thread } from "chat";
import type { KnownBlock, MessageAttachment } from "@slack/web-api";
import type { SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { isExplicitChannelPostIntent } from "@/chat/services/channel-intent";
import {
  logError,
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setTags,
  withSpan,
} from "@/chat/logging";
import { buildSlackOutputMessage } from "@/chat/slack/output";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { createProgressReporter } from "@/chat/runtime/progress-reporter";
import { createSlackAdapterAssistantStatusTransport } from "@/chat/runtime/assistant-status";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import { createTextStreamBridge } from "@/chat/runtime/streaming";
import {
  getChannelId,
  getMessageTs,
  getSlackApiErrorCode,
  getSlackErrorObservabilityAttributes,
  getThreadId,
  getThreadTs,
  getRunId,
  isSlackTitlePermissionError,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import {
  persistThreadState,
  mergeArtifactsState,
} from "@/chat/runtime/thread-state";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import {
  generateThreadTitle,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  generateConversationId,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import {
  getSlackClient,
  isDmChannel,
  normalizeSlackConversationId,
  withSlackRetries,
} from "@/chat/slack/client";
import {
  type CardMessageEntry,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import { lookupSlackUser } from "@/chat/slack/user";
import { resolveReplyDelivery } from "@/chat/runtime/turn";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { markTurnCompleted, markTurnFailed } from "@/chat/runtime/turn";
import { startActiveTurn } from "@/chat/runtime/turn";
import {
  isRedundantReactionAckText,
  isPotentialRedundantReactionAckText,
} from "@/chat/services/reply-delivery-plan";
import type { RenderedCard } from "@/chat/tools/types";

type SlackReplyPostStage =
  | "streaming_initial_post"
  | "thread_reply"
  | "thread_reply_files_followup";

export interface ReplyExecutorServices {
  generateAssistantReply: typeof generateAssistantReplyImpl;
  generateThreadTitle: typeof generateThreadTitle;
  lookupSlackUser: typeof lookupSlackUser;
}

function getExecutionFailureReason(reply: {
  diagnostics: {
    assistantMessageCount: number;
    errorMessage?: string;
    toolErrorCount: number;
  };
}): string {
  const errorMessage = reply.diagnostics.errorMessage?.trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (reply.diagnostics.toolErrorCount > 0) {
    return `${reply.diagnostics.toolErrorCount} tool result error(s)`;
  }
  if (reply.diagnostics.assistantMessageCount > 0) {
    return "assistant returned no text";
  }
  return "empty assistant turn";
}

function createPersistedCardSentMessage(
  thread: Thread,
  entry: CardMessageEntry,
): SentMessage {
  const syntheticMessage: Message = {
    id: entry.messageId,
    threadId: thread.id,
    text: "",
    formatted: { type: "root", children: [] },
    raw: null,
    links: [],
    author: {
      userId: "self",
      userName: botConfig.userName,
      fullName: botConfig.userName,
      isBot: true,
      isMe: true,
    },
    metadata: {
      dateSent: new Date(entry.postedAt),
      edited: false,
    },
    attachments: [],
    toJSON() {
      return {} as ReturnType<Message["toJSON"]>;
    },
  };

  return thread.createSentMessageFromMessage(syntheticMessage);
}

function replaceCardMessageEntry(
  entries: CardMessageEntry[],
  current: CardMessageEntry,
  next: CardMessageEntry,
): void {
  const index = entries.findIndex(
    (entry) => entry.messageId === current.messageId,
  );
  if (index === -1) {
    entries.push(next);
    return;
  }
  entries[index] = next;
}

function isSlackNativeRenderedCard(
  renderedCard: RenderedCard,
): renderedCard is Extract<RenderedCard, { slackMessage: unknown }> {
  return "slackMessage" in renderedCard;
}

function requireCardChannelId(channelId: string | undefined): string {
  if (!channelId) {
    throw new Error("Slack native card delivery requires channel context");
  }
  return channelId;
}

function requireCardThreadTs(threadTs: string | undefined): string {
  if (!threadTs) {
    throw new Error("Slack native card delivery requires thread context");
  }
  return threadTs;
}

function toPersistedCardMessageFields(
  result: SentMessage | { messageId: string; channelMessageTs: string },
): Pick<CardMessageEntry, "messageId" | "channelMessageTs"> {
  if ("messageId" in result) {
    return {
      messageId: result.messageId,
      channelMessageTs: result.channelMessageTs,
    };
  }

  return {
    messageId: result.id,
  };
}

function buildSlackNativeMessagePayload(input: {
  renderedCard: Extract<RenderedCard, { slackMessage: unknown }>;
}): {
  text?: string;
  blocks?: KnownBlock[];
  attachments: MessageAttachment[];
} {
  return {
    ...(input.renderedCard.slackMessage.text
      ? { text: input.renderedCard.slackMessage.text }
      : {}),
    ...(input.renderedCard.slackMessage.blocks
      ? {
          blocks: input.renderedCard.slackMessage
            .blocks as unknown as KnownBlock[],
        }
      : {}),
    attachments: input.renderedCard.slackMessage
      .attachments as unknown as MessageAttachment[],
  };
}

async function postSlackNativeCard(args: {
  channelId: string;
  renderedCard: Extract<RenderedCard, { slackMessage: unknown }>;
  threadTs: string;
}): Promise<{ messageId: string; channelMessageTs: string }> {
  const normalizedChannelId = normalizeSlackConversationId(args.channelId);
  if (!normalizedChannelId) {
    throw new Error("Slack native card posting requires a valid channel ID");
  }

  const response = await withSlackRetries(
    () =>
      getSlackClient().chat.postMessage({
        channel: normalizedChannelId,
        thread_ts: args.threadTs,
        ...buildSlackNativeMessagePayload({
          renderedCard: args.renderedCard,
        }),
      }),
    3,
    { action: "chat.postMessage" },
  );

  if (!response.ts) {
    throw new Error("Slack native card post completed without a message ts");
  }

  return {
    messageId: `slack:${response.ts}`,
    channelMessageTs: response.ts,
  };
}

async function updateSlackNativeCard(args: {
  channelId: string;
  existing: CardMessageEntry;
  renderedCard: Extract<RenderedCard, { slackMessage: unknown }>;
}): Promise<{ messageId: string; channelMessageTs: string }> {
  const normalizedChannelId = normalizeSlackConversationId(args.channelId);
  if (!normalizedChannelId) {
    throw new Error("Slack native card update requires a valid channel ID");
  }
  if (!args.existing.channelMessageTs) {
    throw new Error("Slack native card update requires a persisted message ts");
  }
  const existingMessageTs = args.existing.channelMessageTs;

  const response = await withSlackRetries(
    () =>
      getSlackClient().chat.update({
        channel: normalizedChannelId,
        ts: existingMessageTs,
        ...buildSlackNativeMessagePayload({
          renderedCard: args.renderedCard,
        }),
      }),
    3,
    { action: "chat.update" },
  );

  const nextTs = response.ts ?? existingMessageTs;
  if (!nextTs) {
    throw new Error("Slack native card update completed without a message ts");
  }
  return {
    messageId: `slack:${nextTs}`,
    channelMessageTs: nextTs,
  };
}

async function deliverRenderedCards(args: {
  artifacts: ThreadArtifactsState;
  beforeFirstResponsePost: () => Promise<void>;
  channelId?: string;
  hasPostedTextReply: boolean;
  renderedCards: NonNullable<
    Awaited<
      ReturnType<ReplyExecutorServices["generateAssistantReply"]>
    >["renderedCards"]
  >;
  thread: Thread;
  threadTs?: string;
  turnTraceContext: Record<string, unknown>;
}): Promise<Partial<ThreadArtifactsState> | undefined> {
  if (args.renderedCards.length === 0) {
    return undefined;
  }

  const persistedCardMessages = args.artifacts.cardMessages ?? [];
  const nextCardMessages = [...persistedCardMessages];
  const existingByEntityKey = new Map(
    persistedCardMessages.map((entry) => [entry.entityKey, entry]),
  );
  const updatedEntityKeys = new Set<string>();

  for (const renderedCard of args.renderedCards) {
    const existing = existingByEntityKey.get(renderedCard.entityKey);
    const isSlackNativeCard = isSlackNativeRenderedCard(renderedCard);

    if (existing && !updatedEntityKeys.has(renderedCard.entityKey)) {
      await args.beforeFirstResponsePost();
      try {
        const updated = isSlackNativeCard
          ? await updateSlackNativeCard({
              channelId: requireCardChannelId(args.channelId),
              existing,
              renderedCard,
            })
          : await createPersistedCardSentMessage(args.thread, existing).edit(
              renderedCard.cardElement,
            );
        const nextEntry: CardMessageEntry = {
          ...existing,
          ...toPersistedCardMessageFields(updated),
          postedAt: new Date().toISOString(),
        };
        replaceCardMessageEntry(nextCardMessages, existing, nextEntry);
        updatedEntityKeys.add(renderedCard.entityKey);
        continue;
      } catch (error) {
        logWarn(
          "card_message_edit_failed",
          args.turnTraceContext,
          {
            "app.card.entity_key": renderedCard.entityKey,
            "app.card.plugin": renderedCard.pluginName,
            "error.message":
              error instanceof Error ? error.message : String(error),
          },
          "Failed to update card in place; posting a new card instead",
        );
      }
    }

    await args.beforeFirstResponsePost();
    try {
      const posted = isSlackNativeCard
        ? await postSlackNativeCard({
            channelId: requireCardChannelId(args.channelId),
            renderedCard,
            threadTs: requireCardThreadTs(args.threadTs),
          })
        : await args.thread.post(renderedCard.cardElement);
      nextCardMessages.push({
        entityKey: renderedCard.entityKey,
        ...toPersistedCardMessageFields(posted),
        pluginName: renderedCard.pluginName,
        postedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!args.hasPostedTextReply) {
        throw error;
      }
      logException(
        error,
        "card_message_post_failed",
        args.turnTraceContext,
        {
          "app.card.entity_key": renderedCard.entityKey,
          "app.card.plugin": renderedCard.pluginName,
        },
        "Failed to post rendered card after sending the text reply",
      );
    }
  }

  return {
    cardMessages: nextCardMessages,
  };
}

interface ReplyExecutorDeps {
  getSlackAdapter: () => SlackAdapter;
  resolveUserAttachments: (
    attachments: Message["attachments"] | undefined,
    context: {
      threadId?: string;
      requesterId?: string;
      channelId?: string;
      runId?: string;
      conversation?: PreparedTurnState["conversation"];
      messageTs?: string;
    },
  ) => Promise<
    Array<{
      data?: Buffer;
      mediaType: string;
      filename?: string;
      promptText?: string;
    }>
  >;
  prepareTurnState: (args: {
    explicitMention: boolean;
    message: Message;
    thread: Thread;
    userText: string;
    context: {
      threadId?: string;
      requesterId?: string;
      channelId?: string;
      runId?: string;
    };
  }) => Promise<PreparedTurnState>;
  services: ReplyExecutorServices;
}

export function createReplyToThread(deps: ReplyExecutorDeps) {
  return async function replyToThread(
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      explicitMention?: boolean;
      preparedState?: PreparedTurnState;
    } = {},
  ) {
    if (message.author.isMe) {
      return;
    }

    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(thread, message);
    const threadTs = getThreadTs(threadId);
    const messageTs = getMessageTs(message);
    const runId = getRunId(thread, message);
    const conversationId = threadId ?? runId;

    await withSpan(
      "chat.reply",
      "chat.reply",
      {
        conversationId,
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId,
      },
      async () => {
        const userText = stripLeadingBotMention(message.text, {
          stripLeadingSlackMentionToken:
            options.explicitMention || Boolean(message.isMention),
        });
        const explicitChannelPostIntent = isExplicitChannelPostIntent(userText);

        const preparedState =
          options.preparedState ??
          (await deps.prepareTurnState({
            thread,
            message,
            userText,
            explicitMention: Boolean(
              options.explicitMention || message.isMention,
            ),
            context: {
              threadId,
              requesterId: message.author.userId,
              channelId,
              runId,
            },
          }));

        const turnId = buildDeterministicTurnId(message.id);
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
          updateConversationStats,
        });
        const turnStartedAtMs = Date.now();
        const turnTraceContext = {
          conversationId,
          turnId,
          agentId: turnId,
          slackThreadId: threadId,
          slackUserId: message.author.userId,
          slackChannelId: channelId,
          runId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId,
        };
        setTags({
          conversationId,
          turnId,
          agentId: turnId,
        });
        if (shouldEmitDevAgentTrace()) {
          logInfo(
            "agent_turn_started",
            turnTraceContext,
            {
              "app.message.id": message.id,
              ...(messageTs ? { "messaging.message.id": messageTs } : {}),
            },
            "Agent turn started",
          );
        }
        await persistThreadState(thread, {
          conversation: preparedState.conversation,
        });

        const fallbackIdentity = await deps.services.lookupSlackUser(
          message.author.userId,
        );
        const resolvedUserName =
          message.author.userName ?? fallbackIdentity?.userName;
        if (resolvedUserName) {
          setTags({ slackUserName: resolvedUserName });
        }
        const userAttachments = await deps.resolveUserAttachments(
          message.attachments,
          {
            threadId,
            requesterId: message.author.userId,
            channelId,
            runId,
            conversation: preparedState.conversation,
            messageTs: message.id,
          },
        );

        const progress = createProgressReporter({
          channelId,
          threadTs,
          transport: createSlackAdapterAssistantStatusTransport({
            getSlackAdapter: deps.getSlackAdapter,
          }),
        });
        const textStream = createTextStreamBridge();
        let streamedReplyPromise: Promise<SentMessage> | undefined;
        let pendingStreamText = "";
        let beforeFirstResponsePostCalled = false;
        const beforeFirstResponsePost = async (): Promise<void> => {
          if (beforeFirstResponsePostCalled) {
            return;
          }
          beforeFirstResponsePostCalled = true;
          await options.beforeFirstResponsePost?.();
        };
        const startStreamingReply = () => {
          if (!streamedReplyPromise) {
            const streamingReply = (async () => {
              return await postThreadReply(
                textStream.iterable,
                "streaming_initial_post",
              );
            })();
            streamedReplyPromise = streamingReply;
          }
        };
        const flushPendingStreamText = () => {
          if (!pendingStreamText) {
            return;
          }
          startStreamingReply();
          textStream.push(pendingStreamText);
          pendingStreamText = "";
        };
        const postThreadReply = async (
          payload: Parameters<typeof thread.post>[0],
          stage: SlackReplyPostStage,
        ): Promise<SentMessage> => {
          await beforeFirstResponsePost();
          try {
            return await thread.post(payload);
          } catch (error) {
            logException(
              error,
              "slack_thread_post_failed",
              turnTraceContext,
              {
                "app.slack.reply_stage": stage,
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                ...getSlackErrorObservabilityAttributes(error),
              },
              "Failed to post Slack thread reply",
            );
            throw error;
          }
        };
        await progress.start();
        let persistedAtLeastOnce = false;
        let shouldPersistFailureState = true;

        try {
          const toolChannelId =
            preparedState.artifacts.assistantContextChannelId ?? channelId;
          const reply = await deps.services.generateAssistantReply(userText, {
            assistant: {
              userName: botConfig.userName,
            },
            requester: {
              userId: message.author.userId,
              userName: message.author.userName ?? fallbackIdentity?.userName,
              fullName: message.author.fullName ?? fallbackIdentity?.fullName,
            },
            conversationContext:
              preparedState.routingContext ?? preparedState.conversationContext,
            artifactState: preparedState.artifacts,
            configuration: preparedState.configuration,
            channelConfiguration: preparedState.channelConfiguration,
            userAttachments,
            correlation: {
              conversationId,
              threadId,
              turnId,
              threadTs,
              messageTs,
              runId,
              channelId,
              requesterId: message.author.userId,
            },
            toolChannelId,
            sandbox: {
              sandboxId: preparedState.sandboxId,
              sandboxDependencyProfileHash:
                preparedState.sandboxDependencyProfileHash,
            },
            onStatus: (status) => progress.setStatus(status),
            onTextDelta: (deltaText) => {
              if (explicitChannelPostIntent) {
                return;
              }
              if (streamedReplyPromise) {
                textStream.push(deltaText);
                return;
              }
              pendingStreamText += deltaText;
              if (isPotentialRedundantReactionAckText(pendingStreamText)) {
                return;
              }
              flushPendingStreamText();
            },
          });
          if (streamedReplyPromise) {
            flushPendingStreamText();
          }
          textStream.end();
          const diagnosticsContext = {
            slackThreadId: threadId,
            slackUserId: message.author.userId,
            slackChannelId: channelId,
            runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          };
          const diagnosticsAttributes = {
            "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
            "gen_ai.operation.name": "invoke_agent",
            "app.ai.outcome": reply.diagnostics.outcome,
            "app.ai.assistant_messages":
              reply.diagnostics.assistantMessageCount,
            "app.ai.tool_results": reply.diagnostics.toolResultCount,
            "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
            "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
            "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
            ...(reply.diagnostics.stopReason
              ? {
                  "gen_ai.response.finish_reasons": [
                    reply.diagnostics.stopReason,
                  ],
                }
              : {}),
            ...(reply.diagnostics.errorMessage
              ? { "error.message": reply.diagnostics.errorMessage }
              : {}),
          };
          setSpanAttributes(diagnosticsAttributes);
          if (reply.diagnostics.outcome === "provider_error") {
            const providerError =
              reply.diagnostics.providerError ??
              new Error(
                reply.diagnostics.errorMessage ??
                  "Provider error without explicit message",
              );
            logException(
              providerError,
              "agent_turn_provider_error",
              diagnosticsContext,
              diagnosticsAttributes,
              "Agent turn failed with provider error",
            );
          } else if (reply.diagnostics.outcome !== "success") {
            const failureReason = getExecutionFailureReason(reply);
            logException(
              new Error(`Agent turn execution failure: ${failureReason}`),
              "agent_turn_execution_failure",
              diagnosticsContext,
              {
                ...diagnosticsAttributes,
                "app.ai.execution_failure_reason": failureReason,
              },
              "Agent turn completed with execution failure",
            );
          }

          markConversationMessage(
            preparedState.conversation,
            preparedState.userMessageId,
            {
              replied: true,
              skippedReason: undefined,
            },
          );

          upsertConversationMessage(preparedState.conversation, {
            id: generateConversationId("assistant"),
            role: "assistant",
            text:
              normalizeConversationText(reply.text) ||
              reply.renderedCards
                ?.map((card) => card.fallbackText.trim())
                .filter((text) => text.length > 0)
                .join("\n\n") ||
              "[empty response]",
            createdAtMs: Date.now(),
            author: {
              userName: botConfig.userName,
              isBot: true,
            },
            meta: {
              replied: true,
            },
          });

          const artifactStatePatch: Partial<ThreadArtifactsState> =
            reply.artifactStatePatch ? { ...reply.artifactStatePatch } : {};

          const replyFiles =
            reply.files && reply.files.length > 0 ? reply.files : undefined;
          const { shouldPostThreadReply, attachFiles: resolvedAttachFiles } =
            resolveReplyDelivery({
              reply,
              hasStreamedThreadReply: Boolean(streamedReplyPromise),
            });

          const reactionPerformed = reply.diagnostics.toolCalls.includes(
            "slackMessageAddReaction",
          );

          if (shouldPostThreadReply) {
            if (!streamedReplyPromise) {
              const sent = await postThreadReply(
                buildSlackOutputMessage(
                  reply.text,
                  resolvedAttachFiles === "inline" ? replyFiles : undefined,
                ),
                "thread_reply",
              );
              // When a reaction already acknowledged the turn, delete the
              // redundant thread reply. The post itself completes Slack's
              // assistant response cycle (clearing the typing indicator).
              if (reactionPerformed && isRedundantReactionAckText(reply.text)) {
                await sent.delete();
              }
            } else {
              await streamedReplyPromise;
            }
          }

          const cardArtifactPatch = reply.renderedCards
            ? await deliverRenderedCards({
                artifacts: mergeArtifactsState(
                  preparedState.artifacts,
                  artifactStatePatch,
                ),
                beforeFirstResponsePost,
                channelId,
                hasPostedTextReply: shouldPostThreadReply,
                renderedCards: reply.renderedCards,
                thread,
                threadTs,
                turnTraceContext,
              })
            : undefined;
          if (cardArtifactPatch) {
            Object.assign(artifactStatePatch, cardArtifactPatch);
          }

          const shouldPersistArtifacts =
            Object.keys(artifactStatePatch).length > 0;
          const nextArtifacts = shouldPersistArtifacts
            ? mergeArtifactsState(preparedState.artifacts, artifactStatePatch)
            : undefined;
          markTurnCompleted({
            conversation: preparedState.conversation,
            nowMs: Date.now(),
            updateConversationStats,
          });
          await persistThreadState(thread, {
            artifacts: nextArtifacts,
            conversation: preparedState.conversation,
            sandboxId: reply.sandboxId,
            sandboxDependencyProfileHash: reply.sandboxDependencyProfileHash,
          });
          persistedAtLeastOnce = true;
          if (shouldEmitDevAgentTrace()) {
            logInfo(
              "agent_turn_completed",
              turnTraceContext,
              {
                "app.turn.duration_ms": Date.now() - turnStartedAtMs,
                "app.ai.outcome": reply.diagnostics.outcome,
                "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
                "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
              },
              "Agent turn completed",
            );
          }

          const isFirstAssistantReply =
            preparedState.conversation.stats.compactedMessageCount === 0 &&
            preparedState.conversation.messages.filter(
              (m) => m.role === "assistant",
            ).length === 1;
          if (
            isFirstAssistantReply &&
            channelId &&
            isDmChannel(channelId) &&
            threadTs
          ) {
            void deps.services
              .generateThreadTitle(userText, reply.text)
              .then((title) =>
                deps
                  .getSlackAdapter()
                  .setAssistantTitle(channelId, threadTs, title),
              )
              .catch((error) => {
                const slackErrorCode = getSlackApiErrorCode(error);
                const assistantTitleErrorAttributes = {
                  "app.slack.assistant_title.outcome": "permission_denied",
                  ...(slackErrorCode
                    ? { "app.slack.assistant_title.error_code": slackErrorCode }
                    : {}),
                };
                if (isSlackTitlePermissionError(error)) {
                  setSpanAttributes(assistantTitleErrorAttributes);
                  logError(
                    "thread_title_generation_permission_denied",
                    {
                      slackThreadId: threadId,
                      slackUserId: message.author.userId,
                      slackChannelId: channelId,
                      runId,
                      assistantUserName: botConfig.userName,
                      modelId: botConfig.fastModelId,
                    },
                    assistantTitleErrorAttributes,
                    "Skipping thread title update due to Slack permission error",
                  );
                  return;
                }

                logWarn(
                  "thread_title_generation_failed",
                  {
                    slackThreadId: threadId,
                    slackUserId: message.author.userId,
                    slackChannelId: channelId,
                    runId,
                    assistantUserName: botConfig.userName,
                    modelId: botConfig.fastModelId,
                  },
                  {
                    "error.message":
                      error instanceof Error ? error.message : String(error),
                  },
                  "Thread title generation failed",
                );
              });
          }

          if (
            shouldPostThreadReply &&
            resolvedAttachFiles === "followup" &&
            replyFiles
          ) {
            await postThreadReply(
              buildSlackOutputMessage("", replyFiles),
              "thread_reply_files_followup",
            );
          }
        } catch (error) {
          shouldPersistFailureState = !isRetryableTurnError(
            error,
            "mcp_auth_resume",
          );
          throw error;
        } finally {
          textStream.end();
          if (!persistedAtLeastOnce && shouldPersistFailureState) {
            markTurnFailed({
              conversation: preparedState.conversation,
              nowMs: Date.now(),
              userMessageId: preparedState.userMessageId,
              markConversationMessage: (conversation, messageId, patch) => {
                markConversationMessage(conversation, messageId, patch);
              },
              updateConversationStats,
            });
            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            if (shouldEmitDevAgentTrace()) {
              logWarn(
                "agent_turn_failed",
                turnTraceContext,
                {
                  "app.turn.duration_ms": Date.now() - turnStartedAtMs,
                },
                "Agent turn failed",
              );
            }
          }
          await progress.stop();
        }
      },
    );
  };
}
