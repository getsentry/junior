import {
  createSlackScheduleCreateAutomationTool,
  createSlackScheduleDeleteAutomationTool,
  createSlackScheduleListAutomationsTool,
  createSlackScheduleRunAutomationNowTool,
  createSlackScheduleUpdateAutomationTool,
  type SchedulerToolContext,
} from "@/chat/scheduled-automations/tools";
import {
  getSlackToolContext,
  slackMessageTurnDisabledReason,
} from "@/chat/slack/tool-support/context";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function scheduledAutomationToolContext(
  context: ToolRuntimeContext,
): SchedulerToolContext {
  // A Scheduled automation stores a Slack user as its creator and a Slack
  // channel as its Destination. The tools take these values from the Slack
  // Actor and Slack Source of the Turn. Only a Turn that a person started with
  // a Slack message has both. Scheduler, event automation, and Agent
  // invocation Turns do not act for that person, so they get no Actor or
  // Source here. The runtime disables the tools for those Turns, and the
  // tools also reject the call when they execute.
  const slackMessageTurn =
    context.actor?.platform === "slack" &&
    context.source.kind === "slack" &&
    !slackMessageTurnDisabledReason(context)
      ? { actor: context.actor, source: context.source }
      : undefined;
  return {
    conversationId: context.conversationId,
    ...slackMessageTurn,
    users: {
      resolveActor: context.resolveActorIdentity ?? (async () => undefined),
    },
    ...(context.userText ? { userText: context.userText } : undefined),
  };
}

/**
 * Build scheduled-automation tools for a Conversation with a Slack Location.
 *
 * Registration depends only on the Location, so every Turn in the
 * Conversation sends the same tool list and keeps the prompt cache. Other
 * Turns get the tools disabled.
 */
export function createScheduledAutomationTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  // TODO(dcramer): Let users manage Scheduled automations from web and other
  // Conversations. Remove this check when Scheduled automations no longer
  // require a Slack Destination or Slack creator.
  if (!getSlackToolContext(context)) return {};
  const taskContext = scheduledAutomationToolContext(context);
  return disableTools(
    {
      slackScheduleCreateAutomation:
        createSlackScheduleCreateAutomationTool(taskContext),
      slackScheduleListAutomations:
        createSlackScheduleListAutomationsTool(taskContext),
      slackScheduleUpdateAutomation:
        createSlackScheduleUpdateAutomationTool(taskContext),
      slackScheduleDeleteAutomation:
        createSlackScheduleDeleteAutomationTool(taskContext),
      slackScheduleRunAutomationNow:
        createSlackScheduleRunAutomationNowTool(taskContext),
    },
    slackMessageTurnDisabledReason(context),
  );
}
