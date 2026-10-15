import {
  createSlackScheduleCreateAutomationTool,
  createSlackScheduleDeleteAutomationTool,
  createSlackScheduleListAutomationsTool,
  createSlackScheduleRunAutomationNowTool,
  createSlackScheduleUpdateAutomationTool,
  type SchedulerToolContext,
} from "@/chat/scheduled-automations/tools";
import { getSlackToolContext } from "@/chat/slack/tool-support/context";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function scheduledAutomationToolContext(
  context: ToolRuntimeContext,
): SchedulerToolContext {
  // Pass the Slack Source and Actor only when this Turn has them. The tools
  // reject other Turns when they execute.
  return {
    conversationId: context.conversationId,
    ...(context.actor?.platform === "slack"
      ? { actor: context.actor }
      : undefined),
    ...(context.source.kind === "slack"
      ? { source: context.source }
      : undefined),
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
 * Conversation sends the same tool list and keeps the prompt cache. Each tool
 * checks at execution that a person's Slack message started the Turn.
 */
export function createScheduledAutomationTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  // TODO(dcramer): Let users manage Scheduled automations from web and other
  // Conversations. Remove this check when Scheduled automations no longer
  // require a Slack Destination or Slack creator.
  if (!getSlackToolContext(context)) return {};
  const taskContext = scheduledAutomationToolContext(context);
  return {
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
  };
}
