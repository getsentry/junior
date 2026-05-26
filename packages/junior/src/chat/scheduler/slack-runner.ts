import { botConfig } from "@/chat/config";
import {
  generateAssistantReply as generateAssistantReplyImpl,
  type AssistantReply,
} from "@/chat/respond";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import type { ScheduledTaskRunner } from "@/chat/scheduler/executor";
import {
  SCHEDULED_TASK_SYSTEM_ACTOR,
  type ScheduledRun,
  type ScheduledTask,
} from "@/chat/scheduler/types";
import { logException } from "@/chat/logging";
import { deliverPrivateMessage } from "@/chat/oauth-flow";
import {
  buildConversationContext,
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
  return `slack:${task.destination.teamId}:${task.destination.channelId}`;
}

function buildScheduledConversationText(task: ScheduledTask): string {
  return `[scheduled task] ${task.task.title}: ${task.task.objective}`;
}

function getScheduledAssistantMessageId(run: ScheduledRun): string {
  return `scheduled-run:${run.id}:assistant`;
}

function getExecutionActor(task: ScheduledTask) {
  return task.executionActor ?? SCHEDULED_TASK_SYSTEM_ACTOR;
}

function buildScheduledAuthError(
  error: AuthorizationFlowDisabledError,
): string {
  return `Scheduled task requires ${error.provider} authorization. Connect ${error.provider} in an interactive Slack message, then resume the task.`;
}

function ensureVisibleDeliveryText(reply: AssistantReply): AssistantReply {
  if (reply.text.trim().length > 0 || !reply.files?.length) {
    return reply;
  }

  return {
    ...reply,
    text: "Generated files are attached.",
  };
}

async function notifyCreatorOfBlockedRun(args: {
  errorMessage: string;
  task: ScheduledTask;
}): Promise<void> {
  await deliverPrivateMessage({
    channelId: args.task.destination.channelId,
    userId: args.task.createdBy.slackUserId,
    text: `Scheduled task "${args.task.task.title}" is blocked: ${args.errorMessage}`,
  });
}

function upsertScheduledUserMessage(args: {
  conversation: ThreadConversationState;
  run: ScheduledRun;
  task: ScheduledTask;
}): string {
  const executionActor = getExecutionActor(args.task);
  return upsertConversationMessage(args.conversation, {
    id: `scheduled-run:${args.run.id}:user`,
    role: "user",
    text: normalizeConversationText(buildScheduledConversationText(args.task)),
    createdAtMs: args.run.scheduledForMs,
    author: {
      userName: `system:${executionActor.id}`,
      isBot: true,
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
      const conversationId = getConversationId(task);
      const executionActor = getExecutionActor(task);
      const persisted = await getPersistedThreadState(conversationId);
      const conversation = coerceThreadConversationState(persisted);
      const deliveredMessage = conversation.messages.find(
        (message) =>
          message.id === getScheduledAssistantMessageId(run) &&
          message.meta?.replied === true &&
          typeof message.meta.slackTs === "string",
      );
      if (deliveredMessage?.meta?.slackTs) {
        return {
          status: "completed",
          resultMessageTs: deliveredMessage.meta.slackTs,
        };
      }

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

      try {
        let reply = await generateAssistantReply(prompt, {
          conversationContext,
          artifactState: currentArtifacts,
          piMessages: conversation.piMessages,
          authorizationFlowMode: "disabled",
          configuration,
          channelConfiguration,
          correlation: {
            conversationId,
            threadId: conversationId,
            turnId: `scheduled:${run.id}`,
            runId: run.id,
            channelId: task.destination.channelId,
            teamId: task.destination.teamId,
            actorType: executionActor.type,
            actorId: executionActor.id,
          },
          toolChannelId: task.destination.channelId,
          disableScheduleTools: true,
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
              actorType: executionActor.type,
              actorId: executionActor.id,
              assistantUserName: botConfig.userName,
              modelId: reply.diagnostics.modelId,
            },
          });
        }

        const deliveryReply = ensureVisibleDeliveryText(reply);
        const plannedPosts = planSlackReplyPosts({ reply: deliveryReply });
        const footer = buildSlackReplyFooter({
          conversationId,
          durationMs: deliveryReply.diagnostics.durationMs,
          thinkingLevel: deliveryReply.diagnostics.thinkingLevel,
          usage: deliveryReply.diagnostics.usage,
        });
        const resultMessageTs = await postSlackApiReplyPosts({
          channelId: task.destination.channelId,
          posts: plannedPosts,
          footer,
          fileUploadFailureMode: "strict",
        });

        markConversationMessage(conversation, userMessageId, {
          replied: true,
          skippedReason: undefined,
        });
        upsertConversationMessage(conversation, {
          id: getScheduledAssistantMessageId(run),
          role: "assistant",
          text:
            normalizeConversationText(deliveryReply.text) || "[empty response]",
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
        if (error instanceof AuthorizationFlowDisabledError) {
          const errorMessage = buildScheduledAuthError(error);
          await notifyCreatorOfBlockedRun({
            task,
            errorMessage,
          });
          return {
            status: "blocked",
            errorMessage,
          };
        }
        if (error instanceof PluginCredentialFailureError) {
          await notifyCreatorOfBlockedRun({
            task,
            errorMessage: error.message,
          });
          return {
            status: "blocked",
            errorMessage: error.message,
          };
        }
        if (
          isRetryableTurnError(error, "mcp_auth_resume") ||
          isRetryableTurnError(error, "plugin_auth_resume")
        ) {
          const errorMessage =
            "Scheduled task requires authorization. Connect the required provider in an interactive Slack message, then resume the task.";
          await notifyCreatorOfBlockedRun({
            task,
            errorMessage,
          });
          return {
            status: "blocked",
            errorMessage,
          };
        }

        logException(
          error,
          "scheduled_task_run_failed",
          {
            conversationId,
            slackThreadId: conversationId,
            slackChannelId: task.destination.channelId,
            slackUserId: task.createdBy.slackUserId,
            runId: run.id,
            actorType: executionActor.type,
            actorId: executionActor.id,
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
