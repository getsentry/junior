import { botConfig } from "@/chat/config";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
import type { ScheduledTaskRunner } from "@/chat/scheduler/executor";
import type { ScheduledRun, ScheduledTask } from "@/chat/scheduler/types";
import { logException } from "@/chat/logging";
import { applyPendingAuthUpdate } from "@/chat/services/pending-auth";
import {
  buildConversationContext,
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { finalizeFailedTurnReply } from "@/chat/services/turn-failure-response";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import {
  coerceThreadArtifactsState,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import {
  getChannelConfigurationServiceById,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  planSlackReplyPosts,
  postSlackApiReplyPosts,
} from "@/chat/slack/reply";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";

export interface SlackScheduledTaskRunnerDeps {
  generateAssistantReply?: typeof generateAssistantReplyImpl;
}

function getConversationId(task: ScheduledTask): string {
  return `slack:${task.destination.channelId}:${task.destination.threadTs}`;
}

function buildScheduledConversationText(task: ScheduledTask): string {
  return `[scheduled task] ${task.task.title}: ${task.task.objective}`;
}

function upsertScheduledUserMessage(args: {
  conversation: ThreadConversationState;
  run: ScheduledRun;
  task: ScheduledTask;
}): string {
  return upsertConversationMessage(args.conversation, {
    id: `scheduled-run:${args.run.id}:user`,
    role: "user",
    text: normalizeConversationText(buildScheduledConversationText(args.task)),
    createdAtMs: args.run.scheduledForMs,
    author: {
      userId: args.task.createdBy.slackUserId,
      userName: args.task.createdBy.userName,
      fullName: args.task.createdBy.fullName,
      isBot: false,
    },
    meta: {
      explicitMention: true,
    },
  });
}

async function persistRuntimePatch(args: {
  artifacts?: ThreadArtifactsState;
  conversation: ThreadConversationState;
  sandboxDependencyProfileHash?: string;
  sandboxId?: string;
  threadId: string;
}): Promise<void> {
  await persistThreadStateById(args.threadId, {
    artifacts: args.artifacts,
    conversation: args.conversation,
    sandboxId: args.sandboxId,
    sandboxDependencyProfileHash: args.sandboxDependencyProfileHash,
  });
}

/** Create the Slack runner used by scheduler tick dispatch. */
export function createSlackScheduledTaskRunner(
  deps: SlackScheduledTaskRunnerDeps = {},
): ScheduledTaskRunner {
  const generateAssistantReply =
    deps.generateAssistantReply ?? generateAssistantReplyImpl;

  return {
    run: async ({ prompt, run, task, nowMs }) => {
      const threadTs = task.destination.threadTs;
      if (!threadTs) {
        return {
          status: "blocked",
          errorMessage: "Scheduled Slack task has no thread destination.",
        };
      }

      const conversationId = getConversationId(task);
      const persisted = await getPersistedThreadState(conversationId);
      const conversation = coerceThreadConversationState(persisted);
      const artifacts = coerceThreadArtifactsState(persisted);
      const channelConfiguration = getChannelConfigurationServiceById(
        task.destination.channelId,
      );
      const configuration = await channelConfiguration.resolveValues();
      const userMessageId = upsertScheduledUserMessage({
        conversation,
        run,
        task,
      });
      updateConversationStats(conversation);
      const conversationContext = buildConversationContext(conversation, {
        excludeMessageId: userMessageId,
      });

      let currentArtifacts = artifacts;
      let sandboxId =
        typeof persisted.app_sandbox_id === "string"
          ? persisted.app_sandbox_id
          : undefined;
      let sandboxDependencyProfileHash =
        typeof persisted.app_sandbox_dependency_profile_hash === "string"
          ? persisted.app_sandbox_dependency_profile_hash
          : undefined;
      let authPendingErrorMessage: string | undefined;

      try {
        let reply = await generateAssistantReply(prompt, {
          requester: {
            userId: task.createdBy.slackUserId,
            userName: task.createdBy.userName,
            fullName: task.createdBy.fullName,
          },
          conversationContext,
          artifactState: currentArtifacts,
          piMessages: conversation.piMessages,
          pendingAuth: conversation.processing.pendingAuth,
          configuration,
          channelConfiguration,
          correlation: {
            conversationId,
            threadId: conversationId,
            turnId: `scheduled:${run.id}`,
            runId: run.id,
            channelId: task.destination.channelId,
            teamId: task.destination.teamId,
            requesterId: task.createdBy.slackUserId,
            threadTs,
          },
          toolChannelId: task.destination.channelId,
          sandbox: {
            sandboxId,
            sandboxDependencyProfileHash,
          },
          onSandboxAcquired: async (sandbox) => {
            sandboxId = sandbox.sandboxId;
            sandboxDependencyProfileHash = sandbox.sandboxDependencyProfileHash;
            await persistRuntimePatch({
              threadId: conversationId,
              conversation,
              artifacts: currentArtifacts,
              sandboxId,
              sandboxDependencyProfileHash,
            });
          },
          onArtifactStateUpdated: async (nextArtifacts) => {
            currentArtifacts = nextArtifacts;
            await persistRuntimePatch({
              threadId: conversationId,
              conversation,
              artifacts: currentArtifacts,
              sandboxId,
              sandboxDependencyProfileHash,
            });
          },
          onAuthPending: async (pendingAuth) => {
            authPendingErrorMessage = `Scheduled task requires ${pendingAuth.provider} authorization.`;
            await applyPendingAuthUpdate({
              conversation,
              conversationId,
              nextPendingAuth: pendingAuth,
            });
            await persistRuntimePatch({
              threadId: conversationId,
              conversation,
              artifacts: currentArtifacts,
              sandboxId,
              sandboxDependencyProfileHash,
            });
          },
        });

        const turnFailureErrorMessage =
          reply.diagnostics.outcome === "success"
            ? undefined
            : (reply.diagnostics.errorMessage ??
              `Agent turn ended with ${reply.diagnostics.outcome}.`);
        if (turnFailureErrorMessage) {
          reply = finalizeFailedTurnReply({
            reply,
            logException,
            context: {
              conversationId,
              slackThreadId: conversationId,
              slackChannelId: task.destination.channelId,
              slackUserId: task.createdBy.slackUserId,
              runId: run.id,
              assistantUserName: botConfig.userName,
              modelId: reply.diagnostics.modelId,
            },
          });
        }

        const plannedPosts = planSlackReplyPosts({ reply });
        const footer = buildSlackReplyFooter({
          conversationId,
          durationMs: reply.diagnostics.durationMs,
          thinkingLevel: reply.diagnostics.thinkingLevel,
          usage: reply.diagnostics.usage,
        });
        const resultMessageTs = await postSlackApiReplyPosts({
          channelId: task.destination.channelId,
          threadTs,
          posts: plannedPosts,
          footer,
          fileUploadFailureMode: "strict",
        });

        markConversationMessage(conversation, userMessageId, {
          replied: true,
          skippedReason: undefined,
        });
        upsertConversationMessage(conversation, {
          id: generateConversationId("assistant"),
          role: "assistant",
          text: normalizeConversationText(reply.text) || "[empty response]",
          createdAtMs: nowMs,
          author: {
            userName: botConfig.userName,
            isBot: true,
          },
          meta: {
            replied: true,
            slackTs: resultMessageTs,
          },
        });
        if (reply.piMessages) {
          conversation.piMessages = reply.piMessages;
        }
        updateConversationStats(conversation);

        const nextArtifacts = reply.artifactStatePatch
          ? mergeArtifactsState(currentArtifacts, reply.artifactStatePatch)
          : currentArtifacts;
        await persistRuntimePatch({
          threadId: conversationId,
          conversation,
          artifacts: nextArtifacts,
          sandboxId: reply.sandboxId ?? sandboxId,
          sandboxDependencyProfileHash:
            reply.sandboxDependencyProfileHash ?? sandboxDependencyProfileHash,
        });

        if (authPendingErrorMessage) {
          return {
            status: "blocked",
            errorMessage: authPendingErrorMessage,
          };
        }
        if (turnFailureErrorMessage) {
          return {
            status: "failed",
            errorMessage: turnFailureErrorMessage,
          };
        }

        return {
          status: "completed",
          resultMessageTs,
        };
      } catch (error) {
        logException(
          error,
          "scheduled_task_run_failed",
          {
            conversationId,
            slackThreadId: conversationId,
            slackChannelId: task.destination.channelId,
            slackUserId: task.createdBy.slackUserId,
            runId: run.id,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          },
          {},
          "Scheduled task run failed",
        );
        return {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
