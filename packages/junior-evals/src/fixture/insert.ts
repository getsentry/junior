/**
 * Setup data for tests that run the agent.
 *
 * Each kind of setup data has one insert function. It writes through the
 * product store function for that kind. Insert functions only write data:
 * they never run turns and they contain no assertions. Add one when a test
 * needs a new kind of setup data.
 */
import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { createMemoryStore, type MemoryDb } from "@sentry/junior-memory";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { getDb, getSqlExecutor } from "@/chat/db";
import { createSlackDestination } from "@/chat/destination";
import { createEventAutomation } from "@/chat/event-automations/store";
import { createWatch } from "@/chat/events/store";
import type { EventAutomation } from "@/chat/event-automations/types";
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

/**
 * Store a watch on a Conversation of the test. It lasts two weeks. A later
 * matching event, such as `conversation.continue(githubWebhook(...))`,
 * delivers to that Conversation.
 */
export async function insertWatch(args: {
  conversation: { conversationId: string };
  events: string[];
  identifier: string;
  intent: string;
  label: string;
  namespace?: string;
  resourceType: string;
}): Promise<{ id: string }> {
  const nowMs = Date.now();
  const watch = await createWatch(
    {
      conversationId: args.conversation.conversationId,
      events: args.events,
      expiresAtMs: nowMs + 14 * 24 * 60 * 60 * 1000,
      identifier: args.identifier,
      intent: args.intent,
      label: args.label,
      namespace: args.namespace ?? "github",
      resourceType: args.resourceType,
    },
    { nowMs },
  );
  return { id: watch.id };
}

/**
 * Store a memory that a Slack person asked for, as the memory plugin stores
 * it. The agent needs the memory plugin to recall it in later Conversations.
 */
export async function insertMemory(args: {
  author?: SlackAuthor;
  content: string;
  kind?: "knowledge" | "preference" | "procedure";
  /** What the memory is about. Defaults to the person. */
  subjectType?: "conversation" | "user";
  /**
   * `private` is a memory from a direct message, which only the person can
   * recall. Defaults to `public`, a memory from a public channel.
   */
  visibility?: "private" | "public";
}): Promise<{ id: string }> {
  const author = resolveAuthor(args.author);
  const identity = await insertSlackIdentity(author);
  if (!identity.userId) {
    throw new Error(`The Slack person ${author.userId} has no User`);
  }
  const visibility = args.visibility ?? "public";
  const channel = slackChannel();
  const channelId =
    visibility === "private"
      ? channel.channelId.replace(/^C/, "D")
      : channel.channelId;
  const messageTs = `${Math.floor(Date.now() / 1000)}.000100`;
  const store = createMemoryStore(
    getDb() as unknown as MemoryDb,
    {
      actor: {
        platform: "slack",
        teamId: SLACK_TEAM_ID,
        userId: author.userId,
      },
      conversationId: `slack:${channelId}:${messageTs}`,
      source: createSlackSource({
        channelId,
        messageTs,
        teamId: SLACK_TEAM_ID,
        threadTs: messageTs,
        visibility,
      }),
      userId: identity.userId,
    },
    { embedder: createPluginEmbedder("memory") },
  );
  const input = {
    content: args.content,
    idempotencyKey: randomUUID(),
    kind: args.kind ?? "preference",
  };
  const { memory } =
    args.subjectType === "conversation"
      ? await store.createConversationMemory(input)
      : await store.createMemory(input);
  return { id: memory.id };
}

/**
 * Store an OAuth credential that a Slack person has for a plugin, as the
 * OAuth callback stores it. Credentials are in the state store, which tests
 * share, so the credential is removed when the test finishes.
 */
export async function insertCredential(args: {
  accessToken: string;
  author?: SlackAuthor;
  /** Store an access token that is expired, so its next use refreshes it. */
  expired?: boolean;
  /** The plugin name, such as `sentry`. */
  provider: string;
  refreshToken: string;
  scope?: string;
}): Promise<void> {
  const { userId } = resolveAuthor(args.author);
  const store = createUserTokenStore();
  await store.set(userId, args.provider, {
    accessToken: args.accessToken,
    expiresAt: args.expired ? Date.now() - 1 : Date.now() + 60 * 60 * 1000,
    refreshToken: args.refreshToken,
    ...(args.scope ? { scope: args.scope } : undefined),
  });
  onTestFinished(async () => {
    await store.delete(userId, args.provider);
  });
}
