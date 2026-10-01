/**
 * Setup data for tests that run the agent.
 *
 * Each kind of setup data has one insert function. It writes through the
 * product store function for that kind. Insert functions only write data:
 * they never run turns and they contain no assertions.
 */
import { randomUUID } from "node:crypto";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createMemoryStore, type MemoryDb } from "@sentry/junior-memory";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { getDb, getSqlExecutor } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import { createEventAutomation } from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";
import { createWatch } from "@/chat/events/store";
import { upsertIdentity } from "@/chat/identities/sql";
import { createPluginEmbedder } from "@/chat/plugins/model";
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

/** Store a weekly scheduled automation that a Slack person created. */
export async function insertScheduledAutomation(args: {
  createdBy?: SlackAuthor;
  credentialMode?: "creator" | "system";
  destination: SlackChannel;
  /** Defaults to one week from now, so the automation is not due. */
  nextRunAtMs?: number;
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
    nextRunAtMs: args.nextRunAtMs ?? nowMs + 7 * 24 * 60 * 60 * 1000,
    outcomes: [{ action: "send_message", destination: args.destination }],
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
    task: { text: args.task },
    updatedAtMs: nowMs - 60_000,
  };
  await saveScheduledAutomation(getDb(), automation);
  return { id };
}

/** Store an event automation that answers matching events in a channel. */
export async function insertEventAutomation(args: {
  createdBy?: SlackAuthor;
  destination: SlackChannel;
  task: string;
  trigger: EventAutomation["trigger"];
}): Promise<{ id: string }> {
  const author = resolveAuthor(args.createdBy);
  const id = `eva_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await createEventAutomation(getDb(), {
    id,
    createdAtMs: Date.now() - 60_000,
    createdBy: {
      fullName: author.fullName,
      slackUserId: author.userId,
      userName: author.userName,
    },
    credentialMode: "system",
    destination: args.destination,
    destinationVisibility: "public",
    outcomes: [{ action: "send_message", destination: args.destination }],
    task: { text: args.task },
    trigger: args.trigger,
  });
  return { id };
}

/** Store a watch that wakes a Conversation for matching events. */
export async function insertWatch(args: {
  conversation: { conversationId: string };
  events: string[];
  identifier: string;
  intent: string;
  label: string;
  namespace: string;
  resourceType: string;
}): Promise<void> {
  await createWatch({
    conversationId: args.conversation.conversationId,
    events: args.events,
    expiresAtMs: Date.now() + 14 * 24 * 60 * 60 * 1000,
    identifier: args.identifier,
    intent: args.intent,
    label: args.label,
    namespace: args.namespace,
    resourceType: args.resourceType,
  });
}

/** Store a memory that a Slack person saved in a channel. */
export async function insertMemory(args: {
  author?: SlackAuthor;
  channel: SlackChannel;
  content: string;
  kind?: "knowledge" | "preference" | "procedure";
}): Promise<void> {
  const author = resolveAuthor(args.author);
  const identity = await insertSlackIdentity(author);
  if (!identity.userId) {
    throw new Error("insertMemory() needs a Slack person with a Junior user");
  }
  const threadTs = `${Math.floor(Date.now() / 1000)}.000000`;
  const store = createMemoryStore(
    // The memory plugin reads Junior's database through its own schema.
    getDb() as unknown as MemoryDb,
    {
      actor: {
        platform: "slack",
        teamId: SLACK_TEAM_ID,
        userId: author.userId,
      },
      conversationId: `slack:${args.channel.channelId}:${threadTs}`,
      source: createSlackSource({
        channelId: args.channel.channelId,
        messageTs: threadTs,
        teamId: SLACK_TEAM_ID,
        threadTs,
        visibility: "public",
      }),
      userId: identity.userId,
    },
    { embedder: createPluginEmbedder("junior-memory") },
  );
  await store.createMemory({
    content: args.content,
    idempotencyKey: randomUUID(),
    kind: args.kind ?? "preference",
  });
}

/** Store a provider credential for a Slack person. */
export async function insertCredential(args: {
  author?: SlackAuthor;
  provider: string;
  scope?: string;
}): Promise<void> {
  const author = resolveAuthor(args.author);
  await createUserTokenStore().set(author.userId, args.provider, {
    accessToken: `eval-${args.provider}-access-token`,
    refreshToken: `eval-${args.provider}-refresh-token`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...(args.scope ? { scope: args.scope } : undefined),
  });
}
