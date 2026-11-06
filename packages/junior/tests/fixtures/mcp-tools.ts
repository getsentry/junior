import { getConversationEventStore, getDb, getSqlExecutor } from "@/chat/db";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { insertReviewItem, type ReviewItem } from "@/chat/review-items/store";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { juniorConversationParticipants } from "@/db/schema";

const DESTINATION = {
  channelId: "C123",
  platform: "slack" as const,
  teamId: "T123",
};

async function requireViewer(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  return viewer;
}

/** Store one root Conversation that the named viewer takes part in. */
export async function seedMcpConversation(args: {
  conversationId: string;
  email: string;
  title: string;
}): Promise<void> {
  const sql = getSqlExecutor();
  await createSqlStore(sql).recordActivity({
    conversationId: args.conversationId,
    destination: DESTINATION,
    nowMs: Date.now(),
    title: args.title,
    visibility: "public",
  });
  const viewer = await requireViewer(args.email);
  await sql.db().insert(juniorConversationParticipants).values({
    lastMessageAt: new Date(),
    rootConversationId: args.conversationId,
    userId: viewer.id,
  });
}

/** Append user and assistant messages to one Conversation, oldest first. */
export async function appendMcpMessages(
  conversationId: string,
  messages: readonly {
    messageId?: string;
    role: "assistant" | "user";
    text: string;
  }[],
): Promise<void> {
  const nowMs = Date.now();
  await getConversationEventStore().append(
    conversationId,
    messages.map(({ messageId, role, text }, index) => ({
      data: {
        type: "message" as const,
        messageId: messageId ?? `message-${index}`,
        role,
        text,
      },
      createdAtMs: nowMs + index,
    })),
  );
}

/** Store one open private action Review item assigned to the named viewer. */
export async function seedMcpReviewItem(args: {
  conversationId: string;
  email: string;
  title: string;
}): Promise<ReviewItem> {
  const viewer = await requireViewer(args.email);
  const item = await insertReviewItem(getDb(), {
    addedByConversationId: args.conversationId,
    assignedToEveryone: false,
    assigneeUserIds: [viewer.id],
    body: "Pick one.",
    conversationIds: [args.conversationId],
    dedupeKey: args.title,
    kind: "action",
    nowMs: Date.now(),
    request: {
      question: "Ship it?",
      fields: [
        {
          id: "decision",
          kind: "choice",
          label: "Decision",
          options: [{ label: "Ship" }, { label: "Wait" }],
        },
      ],
    },
    title: args.title,
    visibility: "private",
  });
  if (!item) throw new Error(`Review item ${args.title} was not stored`);
  return item;
}

/**
 * Store one daily scheduled Automation that the named viewer created. Its
 * creator gets a Slack identity in `T123` with the given Slack user ID. A
 * private Automation posts to a private channel, which hides it from people
 * who did not create it.
 */
export async function seedMcpAutomation(args: {
  email: string;
  id: string;
  instruction: string;
  slackUserId: string;
  title: string;
  visibility: "private" | "public";
}): Promise<void> {
  const destination = {
    ...DESTINATION,
    channelId: args.visibility === "public" ? "C123" : "CPRIVATE",
  };
  await createSqlStore(getSqlExecutor()).recordActivity({
    actor: {
      email: args.email,
      platform: "slack",
      slackUserId: args.slackUserId,
      teamId: destination.teamId,
    },
    conversationId: `slack:${destination.channelId}:${args.id}`,
    destination,
    visibility: args.visibility,
  });
  const creator = await requireViewer(args.email);
  const identity = creator.identities.find(
    (candidate) => candidate.provider === "slack",
  );
  if (!identity) throw new Error(`missing Slack identity for ${args.email}`);
  const nowMs = Date.now();
  await saveScheduledAutomation(getDb(), {
    id: args.id,
    conversationAccess: { audience: "channel", visibility: args.visibility },
    createdAtMs: nowMs,
    createdBy: { slackUserId: args.slackUserId },
    creatorIdentityId: identity.id,
    credentialMode: "creator",
    destination,
    nextRunAtMs: nowMs + 60_000,
    outcomes: [],
    schedule: {
      description: "",
      kind: "recurring",
      recurrence: {
        frequency: "daily",
        interval: 1,
        startDate: new Date(nowMs).toISOString().slice(0, 10),
        time: { hour: 12, minute: 0 },
      },
      timezone: "UTC",
    },
    status: "active",
    task: { text: args.instruction },
    title: args.title,
    updatedAtMs: nowMs,
  });
}
