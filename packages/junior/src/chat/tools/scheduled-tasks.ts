import {
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  type SchedulerToolContext,
} from "@/chat/scheduled-tasks/tools";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function scheduledTaskToolContext(
  context: ToolRuntimeContext,
): SchedulerToolContext | undefined {
  // TODO(dcramer): Let users manage Scheduled tasks from web and other Junior
  // Conversations. Remove these Slack checks when task storage can identify
  // its Conversation and User without Slack-only fields. Location provides
  // Slack context; the work owner decides Delivery.
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

/** Build scheduled-task tools for an interactive Slack actor. */
export function createScheduledTaskTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  const taskContext = scheduledTaskToolContext(context);
  if (!taskContext) return {};
  return {
    slackScheduleCreateTask: createSlackScheduleCreateTaskTool(taskContext),
    slackScheduleListTasks: createSlackScheduleListTasksTool(taskContext),
    slackScheduleUpdateTask: createSlackScheduleUpdateTaskTool(taskContext),
    slackScheduleDeleteTask: createSlackScheduleDeleteTaskTool(taskContext),
    slackScheduleRunTaskNow: createSlackScheduleRunTaskNowTool(taskContext),
  };
}
