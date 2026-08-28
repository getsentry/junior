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
  if (
    context.source.platform !== "slack" ||
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
