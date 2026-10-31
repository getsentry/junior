import { createSlackScheduleCreateAutomationTool } from "@/chat/scheduled-automations/tools/create";
import { createSlackScheduleDeleteAutomationTool } from "@/chat/scheduled-automations/tools/delete";
import { createSlackScheduleSearchAutomationsTool } from "@/chat/scheduled-automations/tools/search";
import { createSlackScheduleRunAutomationNowTool } from "@/chat/scheduled-automations/tools/run-now";
import { createSlackScheduleUpdateAutomationTool } from "@/chat/scheduled-automations/tools/update";
import type { SchedulerToolContext } from "@/chat/scheduled-automations/tool-support";
import {
  getSlackToolContext,
  isSlackMessageTurn,
  slackMessageTurnDisabledReason,
} from "@/chat/slack/tool-support/context";
import { disableTools, type ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function scheduledAutomationToolContext(
  context: ToolRuntimeContext,
): SchedulerToolContext {
  // Scheduled automations store the Slack Actor as creator. Only pass the
  // Actor and Source when that person started this Turn.
  const slackMessageTurn = isSlackMessageTurn(context)
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

/** Build scheduled-automation tools for a Conversation with a Slack Location. */
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
      slackScheduleSearchAutomations:
        createSlackScheduleSearchAutomationsTool(taskContext),
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
