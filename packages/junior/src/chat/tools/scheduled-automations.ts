import {
  createSlackScheduleCreateAutomationTool,
  createSlackScheduleDeleteAutomationTool,
  createSlackScheduleListAutomationsTool,
  createSlackScheduleRunAutomationNowTool,
  createSlackScheduleUpdateAutomationTool,
  type SchedulerToolContext,
} from "@/chat/scheduled-automations/tools";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function scheduledAutomationToolContext(
  context: ToolRuntimeContext,
): SchedulerToolContext | undefined {
  // TODO(dcramer): Let users manage Scheduled automations from web and other
  // Conversations. Remove these checks when Scheduled automations no longer require
  // a Slack Destination or Slack creator.
  if (
    context.source.kind !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack" ||
    !context.resolveActorIdentity
  ) {
    return undefined;
  }
  return {
    actor: context.actor,
    source: context.source,
    users: { resolveActor: context.resolveActorIdentity },
    ...(context.userText ? { userText: context.userText } : undefined),
  };
}

/** Build scheduled-automation tools for an interactive Slack actor. */
export function createScheduledAutomationTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  const taskContext = scheduledAutomationToolContext(context);
  if (!taskContext) return {};
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
