import { Chat } from "chat";
import type { FileUpload, PostableMessage } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { captureException, toOptionalString, withSpan } from "@/chat/observability";
import { buildSlackOutputMessage, shouldUseAttachmentFallback } from "@/chat/output";
import { generateAssistantReply } from "@/chat/respond";
import { createCanvas } from "@/chat/slack-actions/canvases";
import {
  buildArtifactStatePatch,
  coerceThreadArtifactsState,
  type ThreadArtifactsState
} from "@/chat/slack-actions/types";
import { lookupSlackUser } from "@/chat/slack-user";
import { createStateAdapter } from "@/chat/state";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBotMention(text: string): string {
  if (!text.trim()) return text;
  const mentionRe = new RegExp(`^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`, "i");
  return text.replace(mentionRe, "").trim();
}

function getThreadId(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((thread as { id?: unknown }).id) ??
    toOptionalString((message as { threadId?: unknown }).threadId) ??
    toOptionalString((message as { threadTs?: unknown }).threadTs)
  );
}

function getThreadTs(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((message as { threadTs?: unknown }).threadTs) ??
    toOptionalString((thread as { threadTs?: unknown }).threadTs)
  );
}

function getWorkflowRunId(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((thread as { runId?: unknown }).runId) ??
    toOptionalString((message as { runId?: unknown }).runId)
  );
}

function getChannelId(message: unknown): string | undefined {
  return toOptionalString((message as { channelId?: unknown }).channelId);
}

function summarizeForThread(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);

  return lines.join("\n") || "Prepared a longer response.";
}

interface ProgressSentMessage {
  delete?: () => Promise<unknown>;
}

interface AssistantThreadMeta {
  channelId: string;
  threadTs: string;
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack") as SlackAdapter;
}

const assistantThreadMetaById = new Map<string, AssistantThreadMeta>();

function createProgressReporter(thread: {
  post: (message: string | PostableMessage) => Promise<unknown>;
  startTyping?: (status?: string) => Promise<void>;
  id?: string;
}) {
  const fallbackStatus = "Still working on it...";
  const assistantStatuses = ["Analyzing context...", "Running tools...", "Drafting response..."];
  const startDelayMs = 3500;
  const assistantTickMs = 7000;
  let active = false;
  let assistantIndex = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let statusMessage: ProgressSentMessage | null = null;

  const postFallbackStatus = async (): Promise<void> => {
    if (!botConfig.progressFallbackEnabled) {
      return;
    }

    try {
      await thread.startTyping?.(fallbackStatus);
      statusMessage = (await thread.post(fallbackStatus)) as ProgressSentMessage;
    } catch {
      // Best effort only.
    }
  };

  const postAssistantStatus = async (text: string): Promise<void> => {
    const threadId = toOptionalString(thread.id);
    const assistantThread = threadId ? assistantThreadMetaById.get(threadId) : undefined;
    if (!assistantThread || !threadId) {
      await postFallbackStatus();
      return;
    }

    try {
      await getSlackAdapter().setAssistantStatus(
        assistantThread.channelId,
        assistantThread.threadTs,
        text,
        assistantStatuses
      );
    } catch {
      await postFallbackStatus();
    }
  };

  return {
    start() {
      active = true;
      timeoutId = setTimeout(async () => {
        if (!active) return;
        await postAssistantStatus(assistantStatuses[assistantIndex]);

        intervalId = setInterval(async () => {
          if (!active) return;
          assistantIndex = (assistantIndex + 1) % assistantStatuses.length;
          await postAssistantStatus(assistantStatuses[assistantIndex]);
        }, assistantTickMs);
      }, startDelayMs);
    },
    async stop() {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
      if (statusMessage?.delete) {
        try {
          await statusMessage.delete();
        } catch {
          // Best effort only.
        }
      }
    }
  };
}

interface ThreadMessageSnapshot {
  text?: string | null;
  author?: {
    isMe?: boolean;
    userName?: string;
    fullName?: string;
  };
}

function buildChatHistory(recentMessages: ThreadMessageSnapshot[] | undefined, currentUserText: string): string | undefined {
  if (!recentMessages || recentMessages.length === 0) {
    return undefined;
  }

  const items = recentMessages
    .filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
    .map((entry) => {
      const role = entry.author?.isMe ? "assistant" : "user";
      const displayName = entry.author?.fullName || entry.author?.userName || role;
      return {
        role,
        displayName,
        text: (entry.text ?? "").trim()
      };
    });

  if (items.length === 0) {
    return undefined;
  }

  const last = items[items.length - 1];
  if (last && last.role === "user" && last.text === currentUserText.trim()) {
    items.pop();
  }

  const window = items.slice(-12);
  if (window.length === 0) {
    return undefined;
  }

  return window.map((item) => `[${item.role}] ${item.displayName}: ${item.text}`).join("\n");
}

export const bot = new Chat({
  userName: botConfig.userName,
  adapters: {
    slack: createSlackAdapter()
  },
  state: createStateAdapter()
});

async function maybePostCanvasFallback(args: {
  text: string;
  files?: FileUpload[];
  userText: string;
  thread: { post: (message: string | PostableMessage) => Promise<unknown> };
  channelId?: string;
  artifactStatePatch?: Partial<ThreadArtifactsState>;
}): Promise<boolean> {
  const { text, files, userText, thread, channelId, artifactStatePatch } = args;

  if (!botConfig.slackCanvasesEnabled || !channelId) {
    return false;
  }

  if (artifactStatePatch?.lastCanvasId) {
    return false;
  }

  if (!shouldUseAttachmentFallback(text)) {
    return false;
  }

  const heading = userText.split("\n")[0]?.trim();
  const title = (heading && heading.length > 0 ? heading : "Junior response").slice(0, 120);

  const created = await createCanvas({
    title,
    markdown: text,
    channelId
  });

  artifactStatePatch && Object.assign(artifactStatePatch, { lastCanvasId: created.canvasId });

  await thread.post({
    markdown: [
      "Summary:",
      summarizeForThread(text),
      "",
      `Created Slack canvas: \`${created.canvasId}\`.`
    ].join("\n"),
    files
  });

  return true;
}

async function replyToThread(
  thread: {
    post: (message: string | PostableMessage) => Promise<unknown>;
    startTyping?: (status?: string) => Promise<void>;
    recentMessages?: ThreadMessageSnapshot[];
    id?: string;
    state?: Promise<unknown | null>;
    setState?: (state: Record<string, unknown>, options?: { replace?: boolean }) => Promise<void>;
  },
  message: {
    author: { isMe: boolean; userId?: string; userName?: string; fullName?: string };
    text?: string | null;
  }
) {
  if (message.author.isMe) {
    return;
  }

  const threadId = getThreadId(thread, message);
  const threadTs = getThreadTs(thread, message);
  const channelId = getChannelId(message);
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
      const userText = stripLeadingBotMention(message.text ?? "");
      const chatHistory = buildChatHistory(thread.recentMessages, userText);
      const fallbackIdentity = await lookupSlackUser(message.author.userId);
      const currentState = coerceThreadArtifactsState(await thread.state);

      await thread.startTyping?.("Thinking...");
      const progress = createProgressReporter(thread);
      progress.start();

      try {
        const reply = await generateAssistantReply(userText, {
          assistant: {
            userId: botConfig.slackBotUserId,
            userName: botConfig.userName
          },
          requester: {
            userId: message.author.userId,
            userName: message.author.userName ?? fallbackIdentity?.userName,
            fullName: message.author.fullName ?? fallbackIdentity?.fullName
          },
          chatHistory,
          artifactState: currentState,
          correlation: {
            threadId,
            threadTs,
            workflowRunId,
            channelId,
            requesterId: message.author.userId
          }
        });

        const artifactStatePatch = reply.artifactStatePatch ? { ...reply.artifactStatePatch } : undefined;

        let usedCanvasFallback = false;
        try {
          usedCanvasFallback = await maybePostCanvasFallback({
            text: reply.text,
            files: reply.files,
            userText,
            thread,
            channelId,
            artifactStatePatch
          });
        } catch (error) {
          captureException(error, {
            slackThreadId: threadId,
            slackUserId: message.author.userId,
            slackChannelId: channelId,
            workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          });
        }

        if (!usedCanvasFallback) {
          await thread.post(
            buildSlackOutputMessage(reply.text, {
              files: reply.files
            })
          );
        }

        if (artifactStatePatch && thread.setState) {
          const nextArtifacts: ThreadArtifactsState = {
            ...currentState,
            ...artifactStatePatch,
            listColumnMap: {
              ...currentState.listColumnMap,
              ...artifactStatePatch.listColumnMap
            }
          };
          await thread.setState(buildArtifactStatePatch(nextArtifacts));
        }
      } finally {
        await progress.stop();
      }
    }
  );
}

async function initializeAssistantThread(event: {
  threadId: string;
  channelId: string;
  threadTs: string;
}): Promise<void> {
  assistantThreadMetaById.set(event.threadId, {
    channelId: event.channelId,
    threadTs: event.threadTs
  });

  const slack = getSlackAdapter();
  await slack.setAssistantTitle(event.channelId, event.threadTs, "Junior");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    { title: "Summarize thread", message: "Summarize the latest discussion in this thread." },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    { title: "Generate image", message: "Generate an image based on this conversation." }
  ]);
}

bot.onNewMention(async (thread, message) => {
  try {
    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(message);
    const workflowRunId = getWorkflowRunId(thread, message);

    await withSpan(
      "workflow.chat_turn",
      "workflow.chat_turn",
      {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      async () => {
        await thread.subscribe();
        await replyToThread(thread, message);
      }
    );
  } catch (error) {
    captureException(error, {
      slackThreadId: getThreadId(thread, message),
      slackUserId: message.author.userId,
      slackChannelId: getChannelId(message),
      workflowRunId: getWorkflowRunId(thread, message),
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onNewMention failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onSubscribedMessage(async (thread, message) => {
  try {
    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(message);
    const workflowRunId = getWorkflowRunId(thread, message);

    await withSpan(
      "workflow.chat_turn",
      "workflow.chat_turn",
      {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      async () => {
        await replyToThread(thread, message);
      }
    );
  } catch (error) {
    captureException(error, {
      slackThreadId: getThreadId(thread, message),
      slackUserId: message.author.userId,
      slackChannelId: getChannelId(message),
      workflowRunId: getWorkflowRunId(thread, message),
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onSubscribedMessage failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onAssistantThreadStarted(async (event) => {
  try {
    await initializeAssistantThread({
      threadId: event.threadId,
      channelId: event.channelId,
      threadTs: event.threadTs
    });
  } catch (error) {
    captureException(error, {
      slackThreadId: event.threadId,
      slackUserId: event.userId,
      slackChannelId: event.channelId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onAssistantThreadStarted failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

bot.onAssistantContextChanged(async (event) => {
  try {
    await initializeAssistantThread({
      threadId: event.threadId,
      channelId: event.channelId,
      threadTs: event.threadTs
    });
  } catch (error) {
    captureException(error, {
      slackThreadId: event.threadId,
      slackUserId: event.userId,
      slackChannelId: event.channelId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onAssistantContextChanged failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
