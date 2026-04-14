import { Buffer } from "node:buffer";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { logException, logWarn } from "@/chat/logging";
import {
  ResumeTurnBusyError,
  postSlackMessage,
  resumeSlackTurn,
} from "@/handlers/oauth-resume";
import { buildSlackOutputMessage } from "@/chat/slack/output";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  getAgentTurnSessionCheckpoint,
  type AgentTurnSessionCheckpoint,
} from "@/chat/state/turn-session-store";
import {
  getPersistedThreadState,
  getPersistedSandboxState,
  mergeArtifactsState,
  persistThreadStateById,
  getChannelConfigurationServiceById,
} from "@/chat/runtime/thread-state";
import { buildThreadParticipants } from "@/chat/runtime/thread-participants";
import { getTurnUserMessage } from "@/chat/runtime/turn-user-message";
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
  isRetryableTurnError,
  markTurnCompleted,
  markTurnFailed,
} from "@/chat/runtime/turn";
import { resolveReplyDelivery } from "@/chat/runtime/turn";
import {
  canScheduleTurnTimeoutResume,
  scheduleTurnTimeoutResume,
  verifyTurnTimeoutResumeRequest,
  type TurnTimeoutResumeRequest,
} from "@/chat/services/timeout-resume";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { AssistantReply } from "@/chat/respond";
import type { WaitUntilFn } from "@/handlers/types";

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

async function deliverReplyToThread(args: {
  channelId: string;
  threadTs: string;
  reply: AssistantReply;
}): Promise<void> {
  const replyFiles =
    args.reply.files && args.reply.files.length > 0
      ? args.reply.files
      : undefined;
  const { shouldPostThreadReply, attachFiles } = resolveReplyDelivery({
    reply: args.reply,
    hasStreamedThreadReply: false,
  });

  if (shouldPostThreadReply) {
    const text = extractSlackText(
      args.reply.text,
      attachFiles === "inline" ? replyFiles : undefined,
    );
    if (text.trim().length > 0) {
      await postSlackMessage(args.channelId, args.threadTs, text);
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
      channelId: args.channelId,
      threadTs: args.threadTs,
      files,
    });
  } catch {
    // Best effort.
  }
}

async function persistCompletedReplyState(args: {
  checkpoint: AgentTurnSessionCheckpoint;
  reply: AssistantReply;
}): Promise<void> {
  // Timeout resumes only persist completion after the final visible reply has
  // already been delivered to Slack.
  const currentState = await getPersistedThreadState(
    args.checkpoint.conversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const nextArtifacts = args.reply.artifactStatePatch
    ? mergeArtifactsState(artifacts, args.reply.artifactStatePatch)
    : undefined;
  const userMessage = getTurnUserMessage(
    conversation,
    args.checkpoint.sessionId,
  );

  markConversationMessage(conversation, userMessage?.id, {
    replied: true,
    skippedReason: undefined,
  });
  upsertConversationMessage(conversation, {
    id: generateConversationId("assistant"),
    role: "assistant",
    text: normalizeConversationText(args.reply.text) || "[empty response]",
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

  await persistThreadStateById(args.checkpoint.conversationId, {
    artifacts: nextArtifacts,
    conversation,
    sandboxId: args.reply.sandboxId,
    sandboxDependencyProfileHash: args.reply.sandboxDependencyProfileHash,
  });
}

async function persistFailedReplyState(
  checkpoint: AgentTurnSessionCheckpoint,
): Promise<void> {
  const currentState = await getPersistedThreadState(checkpoint.conversationId);
  const conversation = coerceThreadConversationState(currentState);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    userMessageId: getTurnUserMessage(conversation, checkpoint.sessionId)?.id,
    markConversationMessage,
    updateConversationStats,
  });

  await persistThreadStateById(checkpoint.conversationId, {
    conversation,
  });
}

async function resumeTimedOutTurn(
  payload: TurnTimeoutResumeRequest,
): Promise<void> {
  const checkpoint = await getAgentTurnSessionCheckpoint(
    payload.conversationId,
    payload.sessionId,
  );
  if (
    !checkpoint ||
    checkpoint.state !== "awaiting_resume" ||
    checkpoint.resumeReason !== "timeout" ||
    checkpoint.checkpointVersion !== payload.expectedCheckpointVersion
  ) {
    return;
  }

  const thread = parseSlackThreadId(payload.conversationId);
  if (!thread) {
    throw new Error(
      `Timeout resume requires a Slack thread conversation id, got "${payload.conversationId}"`,
    );
  }

  const currentState = await getPersistedThreadState(payload.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(conversation, payload.sessionId);
  if (!userMessage?.author?.userId) {
    throw new Error(
      `Unable to locate the persisted user message for timeout resume session "${payload.sessionId}"`,
    );
  }
  if (conversation.processing.activeTurnId !== payload.sessionId) {
    return;
  }

  const channelConfiguration = getChannelConfigurationServiceById(
    thread.channelId,
  );
  const conversationContext = buildConversationContext(conversation, {
    excludeMessageId: userMessage.id,
  });
  const sandbox = getPersistedSandboxState(currentState);

  await resumeSlackTurn({
    messageText: userMessage.text,
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    lockKey: payload.conversationId,
    failureText:
      "I hit an error while resuming that request. Please try the command again.",
    replyContext: {
      assistant: { userName: botConfig.userName },
      requester: {
        userId: userMessage.author.userId,
        userName: userMessage.author.userName,
        fullName: userMessage.author.fullName,
      },
      correlation: {
        conversationId: payload.conversationId,
        turnId: payload.sessionId,
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        requesterId: userMessage.author.userId,
      },
      toolChannelId: artifacts.assistantContextChannelId ?? thread.channelId,
      artifactState: artifacts,
      conversationContext,
      channelConfiguration,
      sandbox,
      threadParticipants: buildThreadParticipants(conversation.messages),
    },
    onReply: async (reply) => {
      await deliverReplyToThread({
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        reply,
      });
    },
    onSuccess: async (reply) => {
      try {
        await persistCompletedReplyState({ checkpoint, reply });
      } catch (persistError) {
        logException(
          persistError,
          "timeout_resume_complete_persist_failed",
          {},
          {
            "app.ai.conversation_id": payload.conversationId,
            "app.ai.session_id": payload.sessionId,
          },
          "Failed to persist completed timeout-resume state after reply delivery",
        );
      }
    },
    onFailure: async (error) => {
      logException(
        error,
        "timeout_resume_failed",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
        },
        "Failed to resume timed-out turn",
      );
      await persistFailedReplyState(checkpoint);
    },
    onAuthPause: async () => {
      logWarn(
        "timeout_resume_reparked_for_auth",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
        },
        "Resumed timed-out turn parked for auth",
      );
    },
    onTimeoutPause: async (error) => {
      if (!isRetryableTurnError(error, "turn_timeout_resume")) {
        throw error;
      }
      const checkpointVersion = error.metadata?.checkpointVersion;
      const nextSliceId = error.metadata?.sliceId;
      if (typeof checkpointVersion !== "number") {
        throw new Error(
          "Timed-out resume turn did not include a checkpoint version",
        );
      }
      if (!canScheduleTurnTimeoutResume(nextSliceId)) {
        logWarn(
          "timeout_resume_slice_limit_reached",
          {},
          {
            "app.ai.conversation_id": payload.conversationId,
            "app.ai.session_id": payload.sessionId,
            ...(typeof nextSliceId === "number"
              ? { "app.ai.resume_slice_id": nextSliceId }
              : {}),
          },
          "Skipped automatic timeout resume because the turn exceeded the slice limit",
        );
        throw new Error(
          "Timed-out turn exceeded the automatic resume slice limit",
        );
      }

      await scheduleTurnTimeoutResume({
        conversationId: payload.conversationId,
        sessionId: payload.sessionId,
        expectedCheckpointVersion: checkpointVersion,
      });
    },
  });
}

/** Handle the authenticated internal timeout-resume callback. */
export async function POST(
  request: Request,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const payload = await verifyTurnTimeoutResumeRequest(request);
  if (!payload) {
    return new Response("Unauthorized", { status: 401 });
  }

  waitUntil(() =>
    resumeTimedOutTurn(payload).catch((error) => {
      if (error instanceof ResumeTurnBusyError) {
        logWarn(
          "timeout_resume_lock_busy",
          {},
          {
            "app.ai.conversation_id": payload.conversationId,
            "app.ai.session_id": payload.sessionId,
          },
          "Skipped timeout resume because another turn owns the thread lock",
        );
        return;
      }
      logException(
        error,
        "timeout_resume_handler_failed",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
        },
        "Timeout resume handler failed",
      );
    }),
  );
  return new Response("Accepted", { status: 202 });
}
