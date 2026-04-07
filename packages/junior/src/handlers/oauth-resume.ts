import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { generateAssistantReply, type AssistantReply } from "@/chat/respond";
import { createSlackWebApiAssistantStatusTransport } from "@/chat/runtime/assistant-status";
import { createProgressReporter } from "@/chat/runtime/progress-reporter";
import { getSlackClient } from "@/chat/slack/client";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import { isRetryableTurnError } from "@/chat/runtime/turn";

function resolveReplyTimeoutMs(explicitTimeoutMs?: number): number | undefined {
  if (typeof explicitTimeoutMs === "number" && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  const raw = process.env.EVAL_AGENT_REPLY_TIMEOUT_MS?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function postSlackMessage(
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

export function createReadOnlyConfigService(
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

export async function resumeAuthorizedRequest(args: {
  messageText: string;
  requesterUserId: string;
  provider: string;
  channelId: string;
  threadTs: string;
  connectedText: string;
  failureText: string;
  correlation?: {
    conversationId?: string;
    turnId?: string;
    channelId?: string;
    threadTs?: string;
    requesterId?: string;
  };
  toolChannelId?: string;
  artifactState?: ThreadArtifactsState;
  conversationContext?: string;
  configuration?: Record<string, unknown>;
  generateReply?: typeof generateAssistantReply;
  onReply?: (reply: AssistantReply) => Promise<void>;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
  replyTimeoutMs?: number;
}) {
  const progress = createProgressReporter({
    channelId: args.channelId,
    threadTs: args.threadTs,
    transport: createSlackWebApiAssistantStatusTransport(),
  });
  await postSlackMessage(args.channelId, args.threadTs, args.connectedText);
  await progress.start();

  try {
    const generateReply = args.generateReply ?? generateAssistantReply;
    const replyPromise = generateReply(args.messageText, {
      assistant: { userName: botConfig.userName },
      requester: { userId: args.requesterUserId },
      correlation: {
        conversationId: args.correlation?.conversationId,
        turnId: args.correlation?.turnId,
        channelId: args.correlation?.channelId ?? args.channelId,
        threadTs: args.correlation?.threadTs ?? args.threadTs,
        requesterId: args.correlation?.requesterId ?? args.requesterUserId,
      },
      toolChannelId: args.toolChannelId,
      conversationContext: args.conversationContext,
      artifactState: args.artifactState,
      configuration: args.configuration,
      channelConfiguration: args.configuration
        ? createReadOnlyConfigService(args.configuration)
        : undefined,
      onStatus: (status) => progress.setStatus(status),
    });
    const replyTimeoutMs = resolveReplyTimeoutMs(args.replyTimeoutMs);
    const reply =
      typeof replyTimeoutMs === "number"
        ? await Promise.race([
            replyPromise,
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `generateAssistantReply timed out after ${replyTimeoutMs}ms`,
                    ),
                  ),
                replyTimeoutMs,
              ),
            ),
          ])
        : await replyPromise;

    await progress.stop();
    if (args.onReply) {
      await args.onReply(reply);
    } else if (reply.text) {
      await postSlackMessage(args.channelId, args.threadTs, reply.text);
    }
    await args.onSuccess?.(reply);
  } catch (error) {
    await progress.stop();

    if (isRetryableTurnError(error, "mcp_auth_resume") && args.onAuthPause) {
      await args.onAuthPause(error);
      return;
    }

    await args.onFailure?.(error);

    await postSlackMessage(args.channelId, args.threadTs, args.failureText);
  }
}
