import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { logException } from "@/chat/observability";
import { generateAssistantReply, type AssistantReply } from "@/chat/respond";
import { getSlackClient } from "@/chat/slack-actions/client";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { truncateStatusText } from "@/chat/status-format";
import { isRetryableTurnError } from "@/chat/turn/errors";

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
  configuration?: Record<string, unknown>;
  onReply?: (reply: AssistantReply) => Promise<void>;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
}) {
  const postStatus = createDebouncedStatusPoster(args.channelId, args.threadTs);
  await postSlackMessage(args.channelId, args.threadTs, args.connectedText);
  await setAssistantStatus(args.channelId, args.threadTs, "Thinking...");

  try {
    const reply = await generateAssistantReply(args.messageText, {
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
      artifactState: args.artifactState,
      configuration: args.configuration,
      channelConfiguration: args.configuration
        ? createReadOnlyConfigService(args.configuration)
        : undefined,
      onStatus: postStatus,
    });

    postStatus.stop();
    if (args.onReply) {
      await args.onReply(reply);
    } else if (reply.text) {
      await postSlackMessage(args.channelId, args.threadTs, reply.text);
    }
    await args.onSuccess?.(reply);
  } catch (error) {
    postStatus.stop();

    if (isRetryableTurnError(error, "mcp_auth_resume") && args.onAuthPause) {
      await args.onAuthPause(error);
      return;
    }

    await args.onFailure?.(error);

    await postSlackMessage(args.channelId, args.threadTs, args.failureText);
  }
}
