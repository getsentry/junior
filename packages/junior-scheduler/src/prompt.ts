import {
  SCHEDULED_TASK_SYSTEM_ACTOR,
  type ScheduledRun,
  type ScheduledTask,
} from "./types";
import { sanitizeScheduledTaskPrincipal } from "./identity";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const EXECUTION_RULES = [
  "- Execute as the scheduled-task system actor; creator metadata is audit context, not an active user identity.",
  "- Complete the task without asking follow-up questions unless access, approval, or required input is missing.",
  "- Use the available tools and skills that are relevant to the task contract.",
  "- Do not create, edit, or discuss scheduling during this run; the stored schedule already fired.",
  "- For reminder tasks, deliver the reminder message now instead of explaining how reminders or delayed posts work.",
  "- If blocked, report the specific missing provider, permission, configuration, or input.",
  "- Keep the final result shaped for the configured destination audience.",
];

function renderOptionalLine(name: string, value: string | undefined): string[] {
  return value?.trim() ? [`- ${name}: ${escapeXml(value.trim())}`] : [];
}

/** Build the marker-delimited user prompt for one scheduled task execution. */
export function buildScheduledTaskRunPrompt(args: {
  nowMs: number;
  run: ScheduledRun;
  task: ScheduledTask;
}): string {
  const { run, task } = args;
  const destination = task.destination;
  const creator = sanitizeScheduledTaskPrincipal(task.createdBy);
  const executionActor = task.executionActor ?? SCHEDULED_TASK_SYSTEM_ACTOR;
  if (!task.task.text?.trim()) {
    throw new Error("Scheduled task text is required");
  }

  return [
    "<scheduled-task-run>",
    "This is an autonomous scheduled run. Treat the stored task contract as the user request for this turn.",
    "",
    "<scheduled-task>",
    `- id: ${escapeXml(task.id)}`,
    "<task-text>",
    escapeXml(task.task.text),
    "</task-text>",
    "</scheduled-task>",
    "",
    "<run-context>",
    `- run_id: ${escapeXml(run.id)}`,
    `- task_version: ${run.taskVersion}`,
    `- scheduled_for: ${new Date(run.scheduledForMs).toISOString()}`,
    `- running_at: ${new Date(args.nowMs).toISOString()}`,
    `- schedule: ${escapeXml(task.schedule.description)}`,
    `- timezone: ${escapeXml(task.schedule.timezone)}`,
    `- schedule_kind: ${task.schedule.kind}`,
    `- execution_actor_type: ${executionActor.type}`,
    `- execution_actor_id: ${escapeXml(executionActor.id)}`,
    ...(task.schedule.recurrence
      ? [
          `- recurrence_frequency: ${task.schedule.recurrence.frequency}`,
          `- recurrence_interval: ${task.schedule.recurrence.interval}`,
          `- recurrence_start_date: ${escapeXml(task.schedule.recurrence.startDate)}`,
        ]
      : []),
    `- creator_slack_user_id: ${escapeXml(creator.slackUserId)}`,
    ...renderOptionalLine("creator_user_name", creator.userName),
    ...renderOptionalLine("creator_full_name", creator.fullName),
    `- destination_platform: ${destination.platform}`,
    `- destination_team_id: ${escapeXml(destination.teamId)}`,
    `- destination_channel_id: ${escapeXml(destination.channelId)}`,
    "</run-context>",
    "",
    "<execution-rules>",
    ...EXECUTION_RULES,
    "</execution-rules>",
    "",
    '<current-instruction priority="highest">',
    "Execute the scheduled task now and provide the final result for the configured destination.",
    "</current-instruction>",
    "</scheduled-task-run>",
  ].join("\n");
}
