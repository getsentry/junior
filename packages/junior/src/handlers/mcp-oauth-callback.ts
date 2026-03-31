import { Buffer } from "node:buffer";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  deleteMcpAuthSession,
  type McpAuthSessionState,
} from "@/chat/mcp/auth-store";
import { buildSlackOutputMessage } from "@/chat/slack/output";
import { finalizeMcpAuthorization } from "@/chat/mcp/oauth";
import { logException, logWarn } from "@/chat/logging";
import type { AssistantReply } from "@/chat/respond";
import {
  mergeArtifactsState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  buildConversationContext,
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { uploadFilesToThread } from "@/chat/slack/client";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import {
  postSlackMessage,
  resumeAuthorizedRequest,
} from "@/handlers/oauth-resume";
import { markTurnCompleted, markTurnFailed } from "@/chat/runtime/turn";
import { resolveReplyDelivery } from "@/chat/runtime/turn";
import { htmlCallbackResponse } from "@/handlers/html";
import type { WaitUntilFn } from "@/handlers/types";

const CALLBACK_PAGES = {
  missing_state: {
    title: "Authorization failed",
    message: "Missing state parameter.",
    status: 400,
  },
  provider_error: {
    title: "Authorization failed",
    message: "The provider returned an authorization error.",
    status: 400,
  },
  missing_code: {
    title: "Authorization failed",
    message: "Missing code parameter.",
    status: 400,
  },
  success: {
    title: "Authorization complete",
    message:
      "Your MCP access is connected. Junior will continue the paused request in Slack.",
    status: 200,
  },
  failure: {
    title: "Authorization failed",
    message:
      "Junior could not finish the authorization callback. Return to Slack and retry the original request.",
    status: 500,
  },
} as const;

function htmlResponse(kind: keyof typeof CALLBACK_PAGES): Response {
  const page = CALLBACK_PAGES[kind];
  return htmlCallbackResponse(page.title, page.message, page.status);
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

async function buildResumeConversationContext(
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<string | undefined> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(threadId),
  );
  const userMessageId = getUserMessageIdForTurn(conversation, sessionId);
  return buildConversationContext(conversation, {
    excludeMessageId: userMessageId,
  });
}

async function persistCompletedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
  reply: AssistantReply,
): Promise<void> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
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

  await persistThreadStateById(threadId, {
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
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    userMessageId: getUserMessageIdForTurn(conversation, sessionId),
    markConversationMessage,
    updateConversationStats,
  });

  await persistThreadStateById(threadId, {
    conversation,
  });
}

async function resumeAuthorizedMcpTurn(args: {
  authSession: McpAuthSessionState;
  provider: string;
}): Promise<void> {
  const { authSession, provider } = args;
  if (!authSession.channelId || !authSession.threadTs) {
    return;
  }

  const conversationContext = await buildResumeConversationContext(
    authSession.channelId,
    authSession.threadTs,
    authSession.sessionId,
  );

  await resumeAuthorizedRequest({
    messageText: authSession.userMessage,
    requesterUserId: authSession.userId,
    provider,
    channelId: authSession.channelId,
    threadTs: authSession.threadTs,
    connectedText: `Your ${provider} MCP access is now connected. Continuing the original request...`,
    failureText:
      "MCP authorization completed, but resuming the request failed. Please retry the original command.",
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
    conversationContext,
    artifactState: authSession.artifactState,
    configuration: authSession.configuration,
    onReply: async (reply) => {
      await deliverReplyToThread(
        authSession.channelId!,
        authSession.threadTs!,
        reply,
      );
    },
    onSuccess: async (reply) => {
      try {
        await persistCompletedReplyState(
          authSession.channelId!,
          authSession.threadTs!,
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
    },
    onFailure: async (error) => {
      logException(
        error,
        "mcp_oauth_callback_resume_failed",
        {},
        { "app.credential.provider": provider },
        "Failed to resume MCP-authorized turn",
      );
      try {
        await persistFailedReplyState(
          authSession.channelId!,
          authSession.threadTs!,
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
    },
    onAuthPause: async () => {
      logWarn(
        "mcp_oauth_callback_resume_reparked_for_auth",
        {},
        { "app.credential.provider": provider },
        "Resumed MCP turn requested another authorization flow",
      );
    },
  });
}

export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const error = url.searchParams.get("error")?.trim();

  if (!state) {
    return htmlResponse("missing_state");
  }
  if (error) {
    return htmlResponse("provider_error");
  }
  if (!code) {
    return htmlResponse("missing_code");
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

    waitUntil(() =>
      resumeAuthorizedMcpTurn({
        authSession,
        provider,
      }),
    );

    return htmlResponse("success");
  } catch (callbackError) {
    logException(
      callbackError,
      "mcp_oauth_callback_failed",
      {},
      { "app.credential.provider": provider },
      "Failed to process MCP OAuth callback",
    );
    return htmlResponse("failure");
  }
}
