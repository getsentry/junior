import { expect } from "vitest";
import { toolCalls } from "vitest-evals";
import { getDb } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import {
  createSchedulerSqlStore,
  type SchedulerDb,
  type ScheduledTask,
} from "@/chat/scheduled-tasks";

interface ScheduledTaskThread {
  channel_id: string;
}

/** Seed an existing scheduled task so management evals exercise only the requested follow-up. */
export async function seedScheduledTask(args: {
  createdBy: {
    fullName?: string;
    slackUserId: string;
    userName?: string;
  };
  credentialMode?: "creator" | "system";
  id: string;
  taskText: string;
  thread: ScheduledTaskThread;
}) {
  const destination = createSlackDestination({
    channelId: args.thread.channel_id,
    teamId: "TEVAL",
  });
  if (!destination || destination.platform !== "slack") {
    throw new Error("Scheduled task eval requires a Slack destination");
  }
  const nowMs = Date.now();
  const task: ScheduledTask = {
    id: args.id,
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: nowMs - 60_000,
    createdBy: args.createdBy,
    creatorIdentityId: `eval:slack:TEVAL:${args.createdBy.slackUserId}`,
    credentialMode: args.credentialMode ?? "system",
    destination,
    nextRunAtMs: nowMs + 7 * 24 * 60 * 60 * 1000,
    schedule: {
      description: "Every Monday at 9:00 AM Pacific",
      kind: "recurring",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        startDate: new Date(nowMs).toISOString().slice(0, 10),
        time: { hour: 9, minute: 0 },
        weekdays: [1],
      },
      timezone: "America/Los_Angeles",
    },
    status: "active",
    task: { text: args.taskText },
    updatedAtMs: nowMs - 60_000,
  };
  await createSchedulerSqlStore(getDb() as unknown as SchedulerDb).saveTask(
    task,
  );
}

export const REMINDER_ONLY_FORBIDDEN_TOOLS = [
  "webSearch",
  "webFetch",
  "bash",
  "readFile",
  "editFile",
  "grep",
  "findFiles",
  "listDir",
  "writeFile",
  "callMcpTool",
  "slackThreadRead",
  "slackChannelListMessages",
] as const;

export function scheduledTaskCreateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "slackScheduleCreateTask" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function scheduledTaskUpdateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "slackScheduleUpdateTask" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function expectNoToolCalls(
  session: Parameters<typeof toolCalls>[0],
  names: readonly string[],
) {
  expect(
    toolCalls(session)
      .map((call) => call.name)
      .filter((name) => names.includes(name)),
  ).toEqual([]);
}
