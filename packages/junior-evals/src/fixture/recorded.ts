/**
 * Recorded conversations: JSON event rows exported from a real Conversation.
 *
 * The export drops the event types that forks do not copy and replaces user
 * ids, emails, team ids, and names. The loader inserts the rows as they are,
 * as a fork copies rows, so a test can continue a real Conversation.
 */
import { UNCOPIED_EVENT_TYPES } from "@/chat/conversations/fork";
import { getConversationStore, getDb } from "@/chat/db";
import { juniorConversationEvents } from "@/db/schema";

/** One stored event row, without its Conversation and actor identity. */
export interface RecordedEventRow {
  createdAtMs: number;
  historyVersion: number;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  schemaVersion: number;
  seq: number;
  type: string;
}

export interface RecordedConversation {
  /** Where the Conversation ran. Slack recordings continue in a Slack thread. */
  surface: "slack" | "web";
  events: RecordedEventRow[];
  version: 1;
}

/** Return whether a history option is a recorded conversation. */
export function isRecordedConversation(
  value: unknown,
): value is RecordedConversation {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1
  );
}

// Person name fields. Tool calls use `name` for the tool, so it stays.
const NAME_KEYS = new Set([
  "authorName",
  "displayName",
  "fullName",
  "realName",
  "userName",
]);

/** Replace people and workspace identifiers with stable placeholders. */
function createSanitizer(): (value: unknown) => unknown {
  const replacements = new Map<string, string>();
  const replace = (
    value: string,
    prefix: string,
    make: (n: number) => string,
  ) => {
    const existing = replacements.get(value);
    if (existing) return existing;
    const count =
      [...replacements.values()].filter((entry) => entry.startsWith(prefix))
        .length + 1;
    const next = make(count);
    replacements.set(value, next);
    return next;
  };
  // Slack ids always contain a digit; capitalized words such as TRACKING do not.
  const sanitizeText = (text: string) =>
    text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) =>
        replace(email.toLowerCase(), "person", (n) => `person${n}@example.com`),
      )
      .replace(/\bdashboard:[a-f0-9]+\b/g, (id) =>
        replace(id, "dashboard:", (n) => `dashboard:person${n}`),
      )
      .replace(/\bT(?=[A-Z]*\d)[A-Z0-9]{6,}\b/g, "TEVAL")
      .replace(/\b[UW](?=[A-Z]*\d)[A-Z0-9]{6,}\b/g, (id) =>
        replace(id, "U0PERSON", (n) => `U0PERSON${n}`),
      );
  const replaceName = (name: string) =>
    replace(`name:${name}`, "Person ", (n) => `Person ${n}`);
  const sanitize = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key && NAME_KEYS.has(key)) return replaceName(value);
      // Encoded payloads keep some fields as JSON strings.
      if (/^[[{]/.test(value)) {
        try {
          return JSON.stringify(sanitize(JSON.parse(value)));
        } catch {
          // Plain text that starts with a bracket.
        }
      }
      // Rendered runtime context names the actor.
      return sanitizeText(value).replace(
        /\b(user_name|full_name): ([^\n]+)/g,
        (_, field: string, name: string) => `${field}: ${replaceName(name)}`,
      );
    }
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
    if (!value || typeof value !== "object") return value;
    // Junior's own name is not personal data.
    const isBot = (value as { isBot?: unknown }).isBot === true;
    return Object.fromEntries(
      Object.entries(value)
        // Identity rows do not exist in the database that loads a recording.
        .filter(([entryKey]) => entryKey !== "authorIdentityId")
        .map(([entryKey, entry]) => [
          entryKey,
          isBot && NAME_KEYS.has(entryKey) ? entry : sanitize(entry, entryKey),
        ]),
    );
  };
  return (value) => sanitize(value);
}

/** Export a Conversation's event rows as a sanitized recording. */
export async function exportRecordedConversation(
  conversationId: string,
): Promise<RecordedConversation> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} was not found`);
  }
  const rows = await getDb().query.juniorConversationEvents.findMany({
    orderBy: (row, { asc }) => [asc(row.seq)],
    where: (row, { eq }) => eq(row.conversationId, conversationId),
  });
  return {
    version: 1,
    surface: conversation.destination?.platform === "slack" ? "slack" : "web",
    events: sanitizeRecordedEvents(
      rows.map((row) => ({
        createdAtMs: row.createdAt.getTime(),
        historyVersion: row.historyVersion,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload,
        schemaVersion: row.schemaVersion,
        seq: row.seq,
        type: row.type,
      })),
    ),
  };
}

/**
 * Drop rows that forks do not copy and replace people and workspace
 * identifiers with stable placeholders.
 */
export function sanitizeRecordedEvents(
  rows: RecordedEventRow[],
): RecordedEventRow[] {
  const sanitize = createSanitizer();
  return rows
    .filter((row) => !UNCOPIED_EVENT_TYPES.has(row.type))
    .map((row) => ({
      ...row,
      payload: sanitize(row.payload) as Record<string, unknown>,
    }));
}

/** Insert a recording's rows into a Conversation whose root exists. */
export async function insertRecordedEvents(
  conversationId: string,
  recording: RecordedConversation,
): Promise<void> {
  if (recording.events.length === 0) return;
  await getDb()
    .insert(juniorConversationEvents)
    .values(
      recording.events.map((row) => ({
        conversationId,
        createdAt: new Date(row.createdAtMs),
        historyVersion: row.historyVersion,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload,
        schemaVersion: row.schemaVersion,
        seq: row.seq,
        type: row.type,
      })),
    );
}

/** The user and assistant texts of a recording, in order. */
export function recordedMessages(
  recording: RecordedConversation,
): Array<{ role: "assistant" | "user"; text: string }> {
  return recording.events.flatMap((row) => {
    const payload = row.payload as { role?: unknown; text?: unknown };
    return row.type === "message" &&
      (payload.role === "assistant" || payload.role === "user") &&
      typeof payload.text === "string"
      ? [{ role: payload.role, text: payload.text }]
      : [];
  });
}
