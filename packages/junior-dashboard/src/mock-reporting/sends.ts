/**
 * Process-local web sends for mock reporting. The composer and Quick
 * questions can then be checked visually without running an agent: each send
 * shows a working Turn, then a fixed reply.
 */
import { createHash } from "node:crypto";
import type {
  ActorIdentity,
  ConversationDetailReport,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

/** Time before the reply shows, so the working state can be seen. */
const MOCK_REPLY_DELAY_MS = 2_000;

type MockSend = {
  actorIdentity: ActorIdentity;
  messageId: string;
  sentAtMs: number;
  text: string;
};

type MockFork = {
  messageId: string;
  quickQuestion: boolean;
  sourceConversationId: string;
};

type MockCreatedConversation = {
  actorIdentity: ActorIdentity;
  conversationId: string;
  createdAtMs: number;
  fork?: MockFork;
  title?: string;
  visibility?: "private" | "public";
};

const createdConversations = new Map<string, MockCreatedConversation>();
const sendsByConversationId = new Map<string, MockSend[]>();
const keptQuickQuestionIds = new Set<string>();

/** Clear mock sends so tests sharing a worker do not leak them. */
export function resetMockSends(): void {
  createdConversations.clear();
  sendsByConversationId.clear();
  keptQuickQuestionIds.clear();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function mockConversationId(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `local:web:${hex.slice(0, 24)}`;
}

function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New conversation";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Start one mock web Conversation. A retry with the same key finds it. */
export function createMockConversation(args: {
  actorIdentity: ActorIdentity;
  idempotencyKey: string;
  message: string;
  visibility?: "private" | "public";
}): string {
  const conversationId = mockConversationId(
    args.actorIdentity.email ?? "",
    args.idempotencyKey,
  );
  if (!createdConversations.has(conversationId)) {
    createdConversations.set(conversationId, {
      actorIdentity: args.actorIdentity,
      conversationId,
      createdAtMs: Date.now(),
      title: titleFromMessage(args.message),
      ...(args.visibility ? { visibility: args.visibility } : undefined),
    });
  }
  return conversationId;
}

/** Fork one mock Conversation at a reply. A retry with the same key finds it. */
export function forkMockConversation(args: {
  actorIdentity: ActorIdentity;
  idempotencyKey: string;
  messageId: string;
  quickQuestion: boolean;
  sourceConversationId: string;
}): string {
  const conversationId = mockConversationId(
    "fork",
    args.sourceConversationId,
    args.idempotencyKey,
  );
  if (!createdConversations.has(conversationId)) {
    createdConversations.set(conversationId, {
      actorIdentity: args.actorIdentity,
      conversationId,
      createdAtMs: Date.now(),
      fork: {
        messageId: args.messageId,
        quickQuestion: args.quickQuestion,
        sourceConversationId: args.sourceConversationId,
      },
    });
  }
  return conversationId;
}

/** Add one web message to a mock Conversation. */
export function recordMockSend(
  conversationId: string,
  send: Omit<MockSend, "sentAtMs">,
): "accepted" | "duplicate" {
  const sends = sendsByConversationId.get(conversationId) ?? [];
  if (sends.some((existing) => existing.messageId === send.messageId)) {
    return "duplicate";
  }
  sendsByConversationId.set(conversationId, [
    ...sends,
    { ...send, sentAtMs: Date.now() },
  ]);
  return "accepted";
}

/** List a mock Quick question as an ordinary fork. */
export function keepMockQuickQuestion(conversationId: string): boolean {
  if (!createdConversations.get(conversationId)?.fork?.quickQuestion) {
    return false;
  }
  keptQuickQuestionIds.add(conversationId);
  return true;
}

/** Return whether lists hide this Conversation: an unkept Quick question. */
export function isUnlistedMockConversation(conversationId: string): boolean {
  return (
    Boolean(createdConversations.get(conversationId)?.fork?.quickQuestion) &&
    !keptQuickQuestionIds.has(conversationId)
  );
}

function sendEvents(
  send: MockSend,
  firstSeq: number,
  nowMs: number,
): { events: ConversationReportEvent[]; replied: boolean } {
  const turnId = `mock-turn:${send.messageId}`;
  const events: ConversationReportEvent[] = [
    {
      seq: firstSeq,
      createdAt: iso(send.sentAtMs),
      data: {
        type: "message",
        messageId: send.messageId,
        role: "user",
        source: "web",
        actorIdentity: send.actorIdentity,
        text: send.text,
      },
    },
    {
      seq: firstSeq + 1,
      createdAt: iso(send.sentAtMs + 1),
      data: {
        type: "turn_lifecycle",
        turnId,
        state: "started",
        inputMessageIds: [send.messageId],
      },
    },
  ];
  const repliedAtMs = send.sentAtMs + MOCK_REPLY_DELAY_MS;
  if (nowMs < repliedAtMs) return { events, replied: false };
  const quote = send.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  events.push(
    {
      seq: firstSeq + 2,
      createdAt: iso(repliedAtMs),
      data: {
        type: "message",
        messageId: `mock-reply:${send.messageId}`,
        role: "assistant",
        text: `Mock reply. No agent ran.\n\n${quote}`,
      },
    },
    {
      seq: firstSeq + 3,
      createdAt: iso(repliedAtMs + 1),
      data: { type: "turn_lifecycle", turnId, state: "succeeded" },
    },
  );
  return { events, replied: true };
}

function withSends<T extends ConversationDetailReport>(
  conversation: T,
  nowMs: number,
): T {
  const sends = sendsByConversationId.get(conversation.conversationId);
  if (!sends?.length) return conversation;
  const events = [...conversation.events];
  let pending = false;
  for (const send of sends) {
    const next = sendEvents(send, (events.at(-1)?.seq ?? -1) + 1, nowMs);
    events.push(...next.events);
    pending ||= !next.replied;
  }
  const lastAt = events.at(-1)?.createdAt ?? conversation.lastSeenAt;
  return {
    ...conversation,
    events,
    lastProgressAt: lastAt,
    lastSeenAt: lastAt,
    status: pending ? "active" : "completed",
  };
}

function createdConversation(
  created: MockCreatedConversation,
  conversations: ReadonlyMap<string, ConversationDetailReport>,
): ConversationDetailReport | undefined {
  const startedAt = iso(created.createdAtMs);
  const base = {
    actorIdentity: created.actorIdentity,
    conversationId: created.conversationId,
    cumulativeDurationMs: 0,
    eventHistory: { status: "available" as const },
    generatedAt: startedAt,
    isParticipant: true,
    lastProgressAt: startedAt,
    lastSeenAt: startedAt,
    startedAt,
    status: "completed" as const,
    surface: "api" as const,
    ...(created.visibility ? { visibility: created.visibility } : undefined),
  };
  if (!created.fork) {
    return {
      ...base,
      displayTitle: created.title ?? "New conversation",
      events: [],
    };
  }
  const { messageId, sourceConversationId } = created.fork;
  const source = conversations.get(sourceConversationId);
  const reply = source?.events.find(
    ({ data }) => data.type === "message" && data.messageId === messageId,
  );
  if (!source || !reply) return undefined;
  // Like a real fork, also copy the end of each copied Turn, so the fork
  // has no open Turn.
  const copiedTurnIds = new Set(
    source.events.flatMap(({ data, seq }) =>
      seq <= reply.seq && data.type === "turn_lifecycle" ? [data.turnId] : [],
    ),
  );
  return {
    ...base,
    displayTitle: source.displayTitle,
    events: source.events.filter(
      ({ data, seq }) =>
        seq <= reply.seq ||
        (data.type === "turn_lifecycle" &&
          data.state !== "started" &&
          copiedTurnIds.has(data.turnId)),
    ),
    forkedFromConversationId: sourceConversationId,
    forkedFromTitle: source.displayTitle,
  };
}

/**
 * Add mock sends to fixture Conversations, and add the Conversations that
 * mock sends started.
 */
export function withMockSends<T extends ConversationDetailReport>(
  fixtures: T[],
): (T | ConversationDetailReport)[] {
  const nowMs = Date.now();
  const conversations = new Map<string, T | ConversationDetailReport>(
    fixtures.map((fixture) => [
      fixture.conversationId,
      withSends(fixture, nowMs),
    ]),
  );
  // Insertion order puts each fork source before its forks.
  for (const created of createdConversations.values()) {
    const conversation = createdConversation(created, conversations);
    if (conversation) {
      conversations.set(created.conversationId, withSends(conversation, nowMs));
    }
  }
  const forksBySource = new Map<string, string[]>();
  for (const created of createdConversations.values()) {
    if (!created.fork || isUnlistedMockConversation(created.conversationId)) {
      continue;
    }
    const { sourceConversationId } = created.fork;
    forksBySource.set(sourceConversationId, [
      ...(forksBySource.get(sourceConversationId) ?? []),
      created.conversationId,
    ]);
  }
  return [...conversations.values()].map((conversation) => {
    const forks = forksBySource.get(conversation.conversationId);
    return forks ? { ...conversation, forks } : conversation;
  });
}
