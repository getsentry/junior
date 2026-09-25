import { toolCalls } from "vitest-evals";
import { getDb } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";

interface ScheduledAutomationThread {
  channel_id: string;
}

/** Seed an existing scheduled automation so management evals exercise only the requested follow-up. */
export async function seedScheduledAutomation(args: {
  createdBy: {
    fullName?: string;
    slackUserId: string;
    userName?: string;
  };
  credentialMode?: "creator" | "system";
  id: string;
  taskText: string;
  thread: ScheduledAutomationThread;
}) {
  const destination = createSlackDestination({
    channelId: args.thread.channel_id,
    teamId: "TEVAL",
  });
  if (!destination || destination.platform !== "slack") {
    throw new Error("Scheduled automation eval requires a Slack destination");
  }
  const nowMs = Date.now();
  const task: ScheduledAutomation = {
    id: args.id,
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: nowMs - 60_000,
    createdBy: args.createdBy,
    creatorIdentityId: `eval:slack:TEVAL:${args.createdBy.slackUserId}`,
    credentialMode: args.credentialMode ?? "system",
    destination,
    outcomes: [],
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
  await saveScheduledAutomation(getDb(), task);
}

export function scheduledAutomationCreateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "slackScheduleCreateAutomation" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function scheduledAutomationUpdateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "slackScheduleUpdateAutomation" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function scheduledAutomationDeleteCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "slackScheduleDeleteAutomation" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function scheduledAutomationListCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "slackScheduleListAutomations" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}
