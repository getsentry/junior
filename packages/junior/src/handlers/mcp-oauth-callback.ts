import { Buffer } from "node:buffer";
import { after } from "next/server";
import { ThreadImpl, type FileUpload } from "chat";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { botConfig } from "@/chat/config";
import { coerceThreadConversationState } from "@/chat/conversation-state";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { deleteMcpAuthSession } from "@/chat/mcp/auth-store";
import { buildSlackOutputMessage } from "@/chat/output";
import { finalizeMcpAuthorization } from "@/chat/mcp/oauth";
import { logException } from "@/chat/observability";
import { generateAssistantReply, type AssistantReply } from "@/chat/respond";
import {
  mergeArtifactsState,
  persistThreadState,
} from "@/chat/runtime/thread-state";
import {
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import {
  getSlackClient,
  uploadFilesToThread,
} from "@/chat/slack-actions/client";
import { coerceThreadArtifactsState } from "@/chat/slack-actions/types";
import { truncateStatusText } from "@/chat/status-format";
import { markTurnCompleted, markTurnFailed } from "@/chat/turn/persist";
import { resolveReplyDelivery } from "@/chat/turn/execute";

function htmlResponse(
  title: string,
  message: string,
  status: number,
): Response {
  const html = renderToStaticMarkup(
    createElement(
      "html",
      null,
      createElement("head", null, createElement("title", null, title)),
      createElement(
        "body",
        {
          style: {
            fontFamily: "system-ui, sans-serif",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: "100vh",
            margin: 0,
          },
        },
        createElement(
          "div",
          {
            style: {
              textAlign: "center",
              maxWidth: 480,
            },
          },
          createElement("h1", null, title),
          createElement("p", null, message),
          createElement(
            "p",
            {
              style: {
                marginTop: "2rem",
                color: "#666",
                fontSize: "0.9em",
              },
            },
            "You can close this tab and return to Slack.",
          ),
        ),
      ),
    ),
  );
  return new Response(`<!DOCTYPE html>${html}`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function postSlackMessage(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  try {
    await getSlackClient().chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
  } catch {
    // Best effort.
  }
}

function extractSlackText(text: string, files?: FileUpload[]): string {
  const message = buildSlackOutputMessage(text, files);
  if (
    typeof message === "object" &&
    message !== null &&
    "markdown" in message &&
    typeof message.markdown === "string"
  ) {
    return message.markdown;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    "raw" in message &&
    typeof message.raw === "string"
  ) {
    return message.raw;
  }
  return text;
}

async function normalizeFileUploads(
  files: FileUpload[],
): Promise<Array<{ data: Buffer; filename: string }>> {
  const normalized: Array<{ data: Buffer; filename: string }> = [];

  for (const file of files) {
    let data: Buffer;
    if (Buffer.isBuffer(file.data)) {
      data = file.data;
    } else if (file.data instanceof ArrayBuffer) {
      data = Buffer.from(file.data);
    } else {
      data = Buffer.from(await file.data.arrayBuffer());
    }
    normalized.push({
      data,
      filename: file.filename,
    });
  }

  return normalized;
}

async function deliverReplyToThread(
  channelId: string,
  threadTs: string,
  reply: AssistantReply,
): Promise<void> {
  const replyFiles =
    reply.files && reply.files.length > 0 ? reply.files : undefined;
  const { shouldPostThreadReply, attachFiles } = resolveReplyDelivery({
    reply,
    hasStreamedThreadReply: false,
  });

  if (shouldPostThreadReply) {
    const text = extractSlackText(
      reply.text,
      attachFiles === "inline" ? replyFiles : undefined,
    );
    if (text.trim().length > 0) {
      await postSlackMessage(channelId, threadTs, text);
    }
  }

  if (!replyFiles || attachFiles === "none") {
    return;
  }

  const files = await normalizeFileUploads(replyFiles);
  if (files.length === 0) {
    return;
  }

  try {
    await uploadFilesToThread({
      channelId,
      threadTs,
      files,
    });
  } catch {
    // Best effort.
  }
}

function createSlackThread(channelId: string, threadTs: string) {
  return ThreadImpl.fromJSON({
    _type: "chat:Thread",
    adapterName: "slack",
    channelId,
    id: `slack:${channelId}:${threadTs}`,
    isDM: channelId.startsWith("D"),
  });
}

function buildDeterministicTurnId(messageId: string): string {
  const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `turn_${sanitized}`;
}

function getUserMessageIdForTurn(
  conversation: ReturnType<typeof coerceThreadConversationState>,
  sessionId: string,
): string | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    if (buildDeterministicTurnId(message.id) === sessionId) {
      return message.id;
    }
  }

  return undefined;
}

async function persistCompletedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
  reply: AssistantReply,
): Promise<void> {
  const thread = createSlackThread(channelId, threadTs);
  const currentState = await thread.state;
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const nextArtifacts = reply.artifactStatePatch
    ? mergeArtifactsState(artifacts, reply.artifactStatePatch)
    : undefined;
  const userMessageId = getUserMessageIdForTurn(conversation, sessionId);

  markConversationMessage(conversation, userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  upsertConversationMessage(conversation, {
    id: generateConversationId("assistant"),
    role: "assistant",
    text: normalizeConversationText(reply.text) || "[empty response]",
    createdAtMs: Date.now(),
    author: {
      userName: botConfig.userName,
      isBot: true,
    },
    meta: {
      replied: true,
    },
  });
  markTurnCompleted({
    conversation,
    nowMs: Date.now(),
    updateConversationStats,
  });

  await persistThreadState(thread, {
    artifacts: nextArtifacts,
    conversation,
    sandboxId: reply.sandboxId,
    sandboxDependencyProfileHash: reply.sandboxDependencyProfileHash,
  });
}

async function persistFailedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<void> {
  const thread = createSlackThread(channelId, threadTs);
  const currentState = await thread.state;
  const conversation = coerceThreadConversationState(currentState);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    userMessageId: getUserMessageIdForTurn(conversation, sessionId),
    markConversationMessage,
    updateConversationStats,
  });

  await persistThreadState(thread, {
    conversation,
  });
}

async function setAssistantStatus(
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  try {
    await getSlackClient().assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    });
  } catch {
    // Best effort.
  }
}

const STATUS_DEBOUNCE_MS = 1000;

function createDebouncedStatusPoster(channelId: string, threadTs: string) {
  let lastPostAt = 0;
  let currentStatus = "";
  let pendingStatus: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const flush = async () => {
    if (stopped || !pendingStatus) return;
    const status = pendingStatus;
    pendingStatus = null;
    pendingTimer = null;
    lastPostAt = Date.now();
    currentStatus = status;
    await setAssistantStatus(channelId, threadTs, status);
  };

  const post = async (status: string) => {
    if (stopped) return;
    const truncated = truncateStatusText(status);
    if (!truncated || truncated === currentStatus) return;

    const now = Date.now();
    const elapsed = now - lastPostAt;
    if (elapsed >= STATUS_DEBOUNCE_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingStatus = null;
      lastPostAt = now;
      currentStatus = truncated;
      await setAssistantStatus(channelId, threadTs, truncated);
      return;
    }

    pendingStatus = truncated;
    if (!pendingTimer) {
      pendingTimer = setTimeout(
        () => {
          void flush();
        },
        Math.max(1, STATUS_DEBOUNCE_MS - elapsed),
      );
    }
  };

  post.stop = () => {
    stopped = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
  };

  return post;
}

function createReadOnlyConfigService(
  values: Record<string, unknown>,
): ChannelConfigurationService {
  const entries = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    scope: "conversation" as const,
    updatedAt: new Date().toISOString(),
  }));

  return {
    get: async (key) => entries.find((entry) => entry.key === key),
    set: async () => {
      throw new Error("Read-only configuration in resumed context");
    },
    unset: async () => false,
    list: async ({ prefix } = {}) =>
      entries.filter((entry) => !prefix || entry.key.startsWith(prefix)),
    resolve: async (key) => values[key],
    resolveValues: async ({ keys, prefix } = {}) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (keys && !keys.includes(key)) continue;
        filtered[key] = value;
      }
      return filtered;
    },
  };
}

type Context = {
  params: Promise<{
    provider: string;
  }>;
};

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const { provider } = await context.params;
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const error = url.searchParams.get("error")?.trim();

  if (!state) {
    return htmlResponse(
      "Authorization failed",
      "Missing state parameter.",
      400,
    );
  }
  if (error) {
    return htmlResponse("Authorization failed", `OAuth error: ${error}`, 400);
  }
  if (!code) {
    return htmlResponse("Authorization failed", "Missing code parameter.", 400);
  }

  try {
    const authSession = await finalizeMcpAuthorization(provider, state, code);
    try {
      await deleteMcpAuthSession(authSession.authSessionId);
    } catch (cleanupError) {
      logException(
        cleanupError,
        "mcp_oauth_callback_session_cleanup_failed",
        {},
        { "app.credential.provider": provider },
        "Failed to delete completed MCP auth session",
      );
    }

    after(async () => {
      if (!authSession.channelId || !authSession.threadTs) {
        return;
      }

      const postStatus = createDebouncedStatusPoster(
        authSession.channelId,
        authSession.threadTs,
      );
      await postSlackMessage(
        authSession.channelId,
        authSession.threadTs,
        `Your ${provider} MCP access is now connected. Continuing the original request...`,
      );
      await setAssistantStatus(
        authSession.channelId,
        authSession.threadTs,
        "Thinking...",
      );

      try {
        const reply = await generateAssistantReply(authSession.userMessage, {
          assistant: { userName: botConfig.userName },
          requester: { userId: authSession.userId },
          correlation: {
            conversationId: authSession.conversationId,
            turnId: authSession.sessionId,
            channelId: authSession.channelId,
            threadTs: authSession.threadTs,
            requesterId: authSession.userId,
          },
          toolChannelId:
            authSession.toolChannelId ??
            authSession.artifactState?.assistantContextChannelId ??
            authSession.channelId,
          artifactState: authSession.artifactState,
          configuration: authSession.configuration,
          channelConfiguration: authSession.configuration
            ? createReadOnlyConfigService(authSession.configuration)
            : undefined,
          onStatus: postStatus,
        });

        postStatus.stop();
        await deliverReplyToThread(
          authSession.channelId,
          authSession.threadTs,
          reply,
        );
        try {
          await persistCompletedReplyState(
            authSession.channelId,
            authSession.threadTs,
            authSession.sessionId,
            reply,
          );
        } catch (persistError) {
          logException(
            persistError,
            "mcp_oauth_callback_resume_persist_failed",
            {},
            { "app.credential.provider": provider },
            "Failed to persist resumed MCP turn state",
          );
        }
      } catch (resumeError) {
        postStatus.stop();
        logException(
          resumeError,
          "mcp_oauth_callback_resume_failed",
          {},
          { "app.credential.provider": provider },
          "Failed to resume MCP-authorized turn",
        );
        try {
          await persistFailedReplyState(
            authSession.channelId,
            authSession.threadTs,
            authSession.sessionId,
          );
        } catch (persistError) {
          logException(
            persistError,
            "mcp_oauth_callback_resume_failure_persist_failed",
            {},
            { "app.credential.provider": provider },
            "Failed to persist failed MCP resume state",
          );
        }
        await postSlackMessage(
          authSession.channelId,
          authSession.threadTs,
          "MCP authorization completed, but resuming the request failed. Please retry the original command.",
        );
      }
    });

    return htmlResponse(
      "Authorization complete",
      "Your MCP access is connected. Junior will continue the paused request in Slack.",
      200,
    );
  } catch (callbackError) {
    logException(
      callbackError,
      "mcp_oauth_callback_failed",
      {},
      { "app.credential.provider": provider },
      "Failed to process MCP OAuth callback",
    );
    return htmlResponse(
      "Authorization failed",
      callbackError instanceof Error
        ? callbackError.message
        : "Unexpected callback error.",
      500,
    );
  }
}
