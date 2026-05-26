import { escapeXml } from "@/chat/xml";
import {
  SCHEDULED_TASK_SYSTEM_ACTOR,
  type ScheduledRun,
  type ScheduledTask,
} from "@/chat/scheduler/types";

const EXECUTION_RULES = [
  "- Execute as the scheduled-task system actor; creator metadata is audit context, not an active user identity.",
  "- Complete the task without asking follow-up questions unless access, approval, or required input is missing.",
  "- Use the available tools and skills that are relevant to the task contract.",
  "- If blocked, report the specific missing provider, permission, configuration, or input.",
  "- Keep the final result shaped for the configured destination audience.",
];

function renderList(tag: string, values: string[] | undefined): string[] {
  const entries = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) {
    return [`<${tag}>`, "</" + tag + ">"];
  }
  return [
    `<${tag}>`,
    ...entries.map((value) => `- ${escapeXml(value)}`),
    `</${tag}>`,
  ];
}

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
  const creator = task.createdBy;
  const executionActor = task.executionActor ?? SCHEDULED_TASK_SYSTEM_ACTOR;

  return [
    "<scheduled-task-run>",
    "This is an autonomous scheduled run. Treat the stored task contract as the user request for this turn.",
    "",
    "<scheduled-task>",
    `- id: ${escapeXml(task.id)}`,
    `- title: ${escapeXml(task.task.title)}`,
    `- objective: ${escapeXml(task.task.objective)}`,
    ...renderOptionalLine("expected_output", task.task.expectedOutput),
    "<instructions>",
    ...task.task.instructions.map(
      (instruction) => `- ${escapeXml(instruction)}`,
    ),
    "</instructions>",
    ...renderList("constraints", task.task.constraints),
    ...renderList("source-context", task.task.sourceContext),
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
