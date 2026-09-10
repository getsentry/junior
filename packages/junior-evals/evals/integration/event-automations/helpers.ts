import { toolCalls } from "vitest-evals";
import { getDb } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import { createEventAutomation } from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";

interface EventAutomationThread {
  channel_id: string;
}

/** Seed one existing event automation so management evals exercise follow-up behavior. */
export async function seedEventAutomation(args: {
  createdBy?: EventAutomation["createdBy"];
  credentialMode?: EventAutomation["credentialMode"];
  id: string;
  taskText: string;
  thread: EventAutomationThread;
}) {
  const destination = createSlackDestination({
    channelId: args.thread.channel_id,
    teamId: "TEVAL",
  });
  if (!destination || destination.platform !== "slack") {
    throw new Error("Event automation eval requires a Slack destination");
  }
  const nowMs = Date.now();
  const task: EventAutomation = {
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
  await createEventAutomation(getDb(), task);
}

/** Select successful event automation creation calls from one normalized session. */
export function eventAutomationCreateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "createEventAutomation" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

/** Select successful calls for one event-automation management tool. */
export function eventAutomationManagementCalls(
  session: Parameters<typeof toolCalls>[0],
  name:
    | "listEventAutomations"
    | "updateEventAutomation"
    | "deleteEventAutomation",
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === name && call.status === "ok" && call.result !== undefined,
  );
}
