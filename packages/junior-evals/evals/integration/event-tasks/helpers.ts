import { toolCalls } from "vitest-evals";
import { getDb } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import { createEventTask } from "@/chat/event-tasks/store";
import type { EventTask } from "@/chat/event-tasks/types";

interface EventTaskThread {
  channel_id: string;
}

/** Seed one existing event task so management evals exercise follow-up behavior. */
export async function seedEventTask(args: {
  createdBy?: EventTask["createdBy"];
  credentialMode?: EventTask["credentialMode"];
  id: string;
  taskText: string;
  thread: EventTaskThread;
}) {
  const destination = createSlackDestination({
    channelId: args.thread.channel_id,
    teamId: "TEVAL",
  });
  if (!destination || destination.platform !== "slack") {
    throw new Error("Event task eval requires a Slack destination");
  }
  const nowMs = Date.now();
  const task: EventTask = {
    id: args.id,
    createdAtMs: nowMs - 60_000,
    createdBy: args.createdBy ?? {
      slackUserId: "U123456",
      userName: "testuser",
      fullName: "Test User",
    },
    credentialMode: args.credentialMode ?? "system",
    destination,
    destinationVisibility: "public",
    task: { text: args.taskText },
    trigger: {
      events: ["issue.closed", "issue.reopened"],
      label: "GitHub issue getsentry/junior#208",
      namespace: "github",
      identifier: "getsentry/junior#208",
      resourceType: "issue",
    },
  };
  await createEventTask(getDb(), task);
}

/** Select successful event task creation calls from one normalized session. */
export function eventTaskCreateCalls(session: Parameters<typeof toolCalls>[0]) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "createEventTask" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

/** Select successful calls for one event-task management tool. */
export function eventTaskManagementCalls(
  session: Parameters<typeof toolCalls>[0],
  name: "listEventTasks" | "updateEventTask" | "deleteEventTask",
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === name && call.status === "ok" && call.result !== undefined,
  );
}
