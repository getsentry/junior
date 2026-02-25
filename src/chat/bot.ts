import { Chat } from "chat";
import type { Attachment, FileUpload, PostableMessage } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { gateway } from "ai";
import { z } from "zod";
import { generateObjectWithTelemetry } from "@/chat/ai";
import { botConfig } from "@/chat/config";
import { captureException, logException, logWarn, toOptionalString, withSpan } from "@/chat/observability";
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

function messageExplicitlyMentionsBot(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const byName = new RegExp(`\\b@?${escapeRegExp(botConfig.userName)}\\b`, "i").test(trimmed);
  if (byName) return true;

  const botUserId = botConfig.slackBotUserId?.trim();
  if (!botUserId) return false;
  return new RegExp(`<@${escapeRegExp(botUserId)}>`, "i").test(trimmed);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

interface AssistantThreadMeta {
  channelId: string;
  threadTs: string;
  updatedAtMs: number;
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack") as SlackAdapter;
}

const assistantThreadMetaById = new Map<string, AssistantThreadMeta>();
const ASSISTANT_THREAD_META_MAX = 500;
const ASSISTANT_THREAD_META_TTL_MS = 1000 * 60 * 60 * 24;

function pruneAssistantThreadMeta(nowMs: number): void {
  for (const [threadId, meta] of assistantThreadMetaById) {
    if (nowMs - meta.updatedAtMs > ASSISTANT_THREAD_META_TTL_MS) {
      assistantThreadMetaById.delete(threadId);
    }
  }

  if (assistantThreadMetaById.size <= ASSISTANT_THREAD_META_MAX) {
    return;
  }

  const overflow = assistantThreadMetaById.size - ASSISTANT_THREAD_META_MAX;
  const oldest = [...assistantThreadMetaById.entries()]
    .sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs)
    .slice(0, overflow);

  for (const [threadId] of oldest) {
    assistantThreadMetaById.delete(threadId);
  }
}

function createProgressReporter(thread: {
  id?: string;
  startTyping?: (status?: string) => Promise<void>;
}) {
  const assistantStatuses = ["Analyzing context...", "Running tools...", "Drafting response..."];
  const startDelayMs = 3500;
  const assistantTickMs = 7000;
  let active = false;
  let assistantIndex = 0;
  let currentStatus = "Thinking...";
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const postAssistantStatus = async (text: string): Promise<void> => {
    currentStatus = text;
    try {
      await thread.startTyping?.(text);
    } catch {
      // Best effort only.
    }

    const threadId = toOptionalString(thread.id);
    const assistantThread = threadId ? assistantThreadMetaById.get(threadId) : undefined;
    if (!assistantThread || !threadId) {
      return;
    }
    assistantThread.updatedAtMs = Date.now();

    try {
      await getSlackAdapter().setAssistantStatus(
        assistantThread.channelId,
        assistantThread.threadTs,
        text,
        assistantStatuses
      );
    } catch {
      // Best effort only.
    }
  };

  return {
    async start() {
      active = true;
      await postAssistantStatus("Analyzing context...");

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
    },
    async setStatus(text: string) {
      if (!active || !text || text === currentStatus) {
        return;
      }
      await postAssistantStatus(text);
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

interface UserInputAttachment {
  data: Buffer;
  mediaType: string;
  filename?: string;
}

const MAX_USER_ATTACHMENTS = 3;
const MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;

async function resolveUserAttachments(
  attachments: Attachment[] | undefined,
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  }
): Promise<UserInputAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: UserInputAttachment[] = [];
  for (const attachment of attachments) {
    if (results.length >= MAX_USER_ATTACHMENTS) break;
    if (attachment.type !== "image" && attachment.type !== "file") continue;

    const mediaType = attachment.mimeType ?? "application/octet-stream";

    try {
      let data: Buffer | null = null;

      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.data instanceof Buffer) {
        data = attachment.data;
      } else if (attachment.url) {
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`attachment fetch failed: ${response.status}`);
        data = Buffer.from(await response.arrayBuffer());
      }

      if (!data) continue;
      if (data.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "skipping user attachment that exceeds size limit",
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
          }
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
        "failed to resolve user attachment",
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
        }
      );
    }
  }

  return results;
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

const replyDecisionSchema = z.object({
  should_reply: z.boolean().describe("Whether Junior should respond to this thread message."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Classifier confidence from 0 to 1."),
  reason: z
    .string()
    .max(160)
    .optional()
    .describe("Short reason for the decision.")
});

const ROUTER_CONFIDENCE_THRESHOLD = 0.72;

async function shouldReplyInSubscribedThread(args: {
  rawText: string;
  text: string;
  chatHistory?: string;
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  };
}): Promise<{ shouldReply: boolean; reason: string }> {
  const text = args.text.trim();
  const rawText = args.rawText.trim();
  if (!text) {
    return { shouldReply: false, reason: "empty message" };
  }

  if (messageExplicitlyMentionsBot(rawText)) {
    return { shouldReply: true, reason: "explicit mention" };
  }

  try {
    const routerSystem = [
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
      `<assistant-name>${escapeXml(botConfig.userName)}</assistant-name>`,
      `<chat-history>${escapeXml(args.chatHistory?.trim() || "[none]")}</chat-history>`
    ].join("\n");

    const result = await generateObjectWithTelemetry(
      {
        model: gateway(botConfig.routerModelId),
        schema: replyDecisionSchema,
        maxOutputTokens: 80,
        temperature: 0,
        system: routerSystem,
        prompt: rawText
      },
      {
        functionId: "workflow.should_reply_in_subscribed_thread",
        metadata: {
          modelId: botConfig.routerModelId,
          threadId: args.context.threadId ?? "",
          channelId: args.context.channelId ?? "",
          requesterId: args.context.requesterId ?? "",
          workflowRunId: args.context.workflowRunId ?? ""
        }
      }
    );

    const parsed = replyDecisionSchema.parse(result.object);
    const reason = parsed.reason?.trim() || "llm classifier";
    if (!parsed.should_reply) {
      return {
        shouldReply: false,
        reason
      };
    }

    if (parsed.confidence < ROUTER_CONFIDENCE_THRESHOLD) {
      return {
        shouldReply: false,
        reason: `low confidence (${parsed.confidence.toFixed(2)}): ${reason}`
      };
    }

    return {
      shouldReply: true,
      reason
    };
  } catch (error) {
    logWarn(
      "subscribed-thread reply classifier failed; skipping reply",
      {
        slackThreadId: args.context.threadId,
        slackUserId: args.context.requesterId,
        slackChannelId: args.context.channelId,
        workflowRunId: args.context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.routerModelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error)
      }
    );
    return {
      shouldReply: false,
      reason: "classifier error"
    };
  }
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

  if (!channelId) {
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

  artifactStatePatch &&
    Object.assign(artifactStatePatch, {
      lastCanvasId: created.canvasId,
      lastCanvasUrl: created.permalink
    });

  const canvasLine = created.permalink
    ? `Created Slack canvas: <${created.permalink}|open canvas>.`
    : `Created Slack canvas: \`${created.canvasId}\`.`;

  await thread.post({
    markdown: [
      "Summary:",
      summarizeForThread(text),
      "",
      canvasLine
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
    attachments?: Attachment[];
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
      const userAttachments = await resolveUserAttachments(message.attachments, {
        threadId,
        requesterId: message.author.userId,
        channelId,
        workflowRunId
      });

      const progress = createProgressReporter(thread);
      await progress.start();

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
          userAttachments,
          correlation: {
            threadId,
            threadTs,
            workflowRunId,
            channelId,
            requesterId: message.author.userId
          },
          onStatus: (status) => progress.setStatus(status)
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
          const latestState = coerceThreadArtifactsState(await thread.state);
          const nextArtifacts: ThreadArtifactsState = {
            ...latestState,
            ...artifactStatePatch,
            listColumnMap: {
              ...latestState.listColumnMap,
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
  const nowMs = Date.now();
  assistantThreadMetaById.set(event.threadId, {
    channelId: event.channelId,
    threadTs: event.threadTs,
    updatedAtMs: nowMs
  });
  pruneAssistantThreadMeta(nowMs);

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
    const observabilityContext = {
      slackThreadId: getThreadId(thread, message),
      slackUserId: message.author.userId,
      slackChannelId: getChannelId(message),
      workflowRunId: getWorkflowRunId(thread, message),
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    };
    logException(error, "onNewMention failed", observabilityContext);
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onSubscribedMessage(async (thread, message) => {
  try {
    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(message);
    const workflowRunId = getWorkflowRunId(thread, message);
    const rawUserText = message.text ?? "";
    const userText = stripLeadingBotMention(rawUserText);
    const chatHistory = buildChatHistory(thread.recentMessages, userText);
    const decision = await shouldReplyInSubscribedThread({
      rawText: rawUserText,
      text: userText,
      chatHistory,
      context: {
        threadId,
        requesterId: message.author.userId,
        channelId,
        workflowRunId
      }
    });

    if (!decision.shouldReply) {
      logWarn(
        "skipping subscribed message reply",
        {
          slackThreadId: threadId,
          slackUserId: message.author.userId,
          slackChannelId: channelId,
          workflowRunId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId
        },
        {
          "app.decision.reason": decision.reason
        }
      );
      return;
    }

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
    const observabilityContext = {
      slackThreadId: getThreadId(thread, message),
      slackUserId: message.author.userId,
      slackChannelId: getChannelId(message),
      workflowRunId: getWorkflowRunId(thread, message),
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    };
    logException(error, "onSubscribedMessage failed", observabilityContext);
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
    const observabilityContext = {
      slackThreadId: event.threadId,
      slackUserId: event.userId,
      slackChannelId: event.channelId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    };
    logException(error, "onAssistantThreadStarted failed", observabilityContext);
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
    const observabilityContext = {
      slackThreadId: event.threadId,
      slackUserId: event.userId,
      slackChannelId: event.channelId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    };
    logException(error, "onAssistantContextChanged failed", observabilityContext);
  }
});
