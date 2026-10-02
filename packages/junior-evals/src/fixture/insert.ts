/**
 * Setup data for tests that run the agent.
 *
 * Each kind of setup data has one insert function. It writes through the
 * product store function for that kind. Insert functions only write data:
 * they never run turns and they contain no assertions. Add one when a test
 * needs a new kind of setup data.
 */
import { randomUUID } from "node:crypto";
import { getDb, getSqlExecutor } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import { createEventAutomation } from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";
import { upsertIdentity } from "@/chat/identities/sql";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import {
  SCHEDULED_AUTOMATION_SYSTEM_ACTOR,
  type ScheduledAutomation,
} from "@/chat/scheduled-automations/types";
import type { SlackAuthor } from "./inputs";
import { DEFAULT_SLACK_AUTHOR, SLACK_TEAM_ID, slackAuthorEmail } from "./slack";

/** A Slack channel that automations and mentions can target. */
export interface SlackChannel {
  channelId: string;
  platform: "slack";
  teamId: string;
}

let channelSequence = 0;

/** Return a new public Slack channel in the test workspace. */
export function slackChannel(): SlackChannel {
  channelSequence += 1;
  const suffix = `${Date.now().toString(36)}${channelSequence}`.toUpperCase();
  const destination = createSlackDestination({
    channelId: `CEVALSET${suffix}`,
    teamId: SLACK_TEAM_ID,
  });
  if (destination?.platform !== "slack") {
    throw new Error("slackChannel() needs a Slack destination");
  }
  return { ...destination, platform: "slack" };
}

function resolveAuthor(author: SlackAuthor | undefined) {
  const userId = author?.userId ?? DEFAULT_SLACK_AUTHOR.userId;
  return {
    fullName: author?.fullName ?? DEFAULT_SLACK_AUTHOR.fullName,
    userId,
    userName: author?.userName ?? DEFAULT_SLACK_AUTHOR.userName,
  };
}

/** Store the Slack person as Junior's identity for them. */
async function insertSlackIdentity(author: Required<SlackAuthor>) {
  return await upsertIdentity(getSqlExecutor(), {
    displayName: author.fullName,
    email: slackAuthorEmail(author),
    emailVerified: true,
    handle: author.userName,
    kind: "user",
    provider: "slack",
    providerSubjectId: author.userId,
    providerTenantId: SLACK_TEAM_ID,
  });
}

/**
 * Store a scheduled automation that a Slack person created. It is weekly and
 * next runs in a week unless `due` or `once` says otherwise.
 */
export async function insertScheduledAutomation(args: {
  createdBy?: SlackAuthor;
  credentialMode?: "creator" | "system";
  destination: SlackChannel;
  /** Make the automation due, so the next `heartbeat()` runs it. */
  due?: boolean;
  /** Run one time instead of every week. */
  once?: boolean;
  task: string;
}): Promise<{ id: string }> {
  const author = resolveAuthor(args.createdBy);
  const identity = await insertSlackIdentity(author);
  const nowMs = Date.now();
  const id = `sched_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const automation: ScheduledAutomation = {
    id,
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: nowMs - 60_000,
    createdBy: {
      fullName: author.fullName,
      slackUserId: author.userId,
      userName: author.userName,
    },
    creatorIdentityId: identity.id,
    credentialMode: args.credentialMode ?? "creator",
    destination: args.destination,
    executionActor: SCHEDULED_AUTOMATION_SYSTEM_ACTOR,
    nextRunAtMs: args.due ? nowMs : nowMs + 7 * 24 * 60 * 60 * 1000,
    outcomes: [{ action: "send_message", destination: args.destination }],
    schedule: args.once
      ? {
          description: "Once at 9:00 AM Pacific",
          kind: "one_off",
          timezone: "America/Los_Angeles",
        }
      : {
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
    task: { text: args.task },
    updatedAtMs: nowMs - 60_000,
  };
  await saveScheduledAutomation(getDb(), automation);
  return { id };
}

/**
 * Store an event automation that a Slack person created. It posts its result
 * to `destination` when an event matches `trigger`.
 */
export async function insertEventAutomation(args: {
  createdBy?: SlackAuthor;
  credentialMode?: "creator" | "system";
  destination: SlackChannel;
  task: string;
  trigger: EventAutomation["trigger"];
}): Promise<{ id: string }> {
  const author = resolveAuthor(args.createdBy);
  await insertSlackIdentity(author);
  const id = `evt_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await createEventAutomation(getDb(), {
    id,
    createdAtMs: Date.now() - 60_000,
    createdBy: {
      fullName: author.fullName,
      slackUserId: author.userId,
      userName: author.userName,
    },
    credentialMode: args.credentialMode ?? "system",
    destination: args.destination,
    destinationVisibility: "public",
    outcomes: [{ action: "send_message", destination: args.destination }],
    task: { text: args.task },
    trigger: args.trigger,
  });
  return { id };
}
