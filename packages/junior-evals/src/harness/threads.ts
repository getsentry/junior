/**
 * Harness Slack threads, transcripts, and session message recording.
 */
import { Message as ChatMessage, type Message } from "chat";
import { type Destination } from "@sentry/junior-plugin-api";
import { deleteConversationState } from "@/chat/task-execution/state";
import { turnCursorKey } from "@/chat/task-execution/turn-cursor-keys";
import {
  createTestThread,
  type TestThread,
} from "@junior-tests/fixtures/slack-harness";
import { createSlackDestination } from "@/chat/destination";
import {
  type EvalEventThreadFixture,
  type MentionEvent,
  type SubscribedMessageEvent,
  scenarioEvents,
  type EvalScenario,
  type EvalAssistantPost,
  type EvalSlackThreadReply,
  type EvalThreadRecord,
  type RuntimeObservations,
} from "./types";
import { type HarnessStateAdapter } from "./environment";
import { toEvalAssistantPost } from "./slack-artifacts";

export const EVAL_SLACK_TEAM_ID = "TEVAL";

/** Return the runtime conversation id for a thread fixture. */
export function buildRuntimeThreadId(fixture: EvalEventThreadFixture): string {
  if (fixture.channel_id && fixture.thread_ts) {
    return `slack:${fixture.channel_id}:${fixture.thread_ts}`;
  }
  return fixture.id;
}

/** Return the Slack destination for a harness thread. */
export function createEvalDestination(
  thread: TestThread,
): Extract<Destination, { platform: "slack" }> {
  const destination = createSlackDestination({
    teamId: EVAL_SLACK_TEAM_ID,
    channelId: thread.channelId,
  });
  if (!destination || destination.platform !== "slack") {
    throw new Error("Eval Slack destination requires a Slack channel id");
  }
  return destination;
}

/** Expose the harness transcript through the Chat SDK thread message accessors. */
export function attachTranscriptAccessors(
  thread: TestThread,
  transcript: Message[],
): void {
  Object.defineProperty(thread, "recentMessages", {
    configurable: true,
    enumerable: true,
    get() {
      return [...transcript];
    },
  });
  Object.defineProperty(thread, "messages", {
    configurable: true,
    enumerable: true,
    get() {
      return (async function* () {
        for (const message of [...transcript].reverse()) {
          yield message;
        }
      })();
    },
  });
}

/** Delete conversation, turn, and channel state for every thread in a scenario. */
export async function cleanupHarnessThreadState(
  stateAdapter: HarnessStateAdapter,
  scenario: EvalScenario,
): Promise<void> {
  const events = scenarioEvents(scenario);
  const runtimeThreadIds = new Set(
    events.map((event) => buildRuntimeThreadId(event.thread)),
  );
  const turnCursorKeys = events
    .filter(
      (event): event is MentionEvent | SubscribedMessageEvent =>
        "message" in event,
    )
    .map((event) => {
      const messageId = event.message.id ?? "";
      const turnId = `turn_${messageId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      return turnCursorKey(buildRuntimeThreadId(event.thread), turnId);
    });
  const channelIds = new Set(
    events
      .map((event) => event.thread.channel_id?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  for (const threadId of runtimeThreadIds) {
    await deleteConversationState({
      conversationId: threadId,
      state: stateAdapter,
    });
    await stateAdapter.delete(`thread-state:${threadId}`);
    await stateAdapter.unsubscribe(threadId);
  }
  for (const key of turnCursorKeys) {
    await stateAdapter.delete(key);
  }
  for (const channelId of channelIds) {
    await stateAdapter.delete(`channel-state:${channelId}`);
  }
}

/** Create a harness thread whose subscribe state mirrors the shared state adapter. */
export async function createEvalThread(args: {
  fixture: EvalEventThreadFixture;
  channelStateRef?: { value: Record<string, unknown> };
  stateAdapter: HarnessStateAdapter;
}): Promise<TestThread> {
  // createTestThread already seeds Junior adapter scratch; keep subscribe state
  // mirrored onto the shared adapter for mailbox-backed ingress.
  const thread = await createTestThread({
    id: buildRuntimeThreadId(args.fixture),
    channelId: args.fixture.channel_id,
    runId: args.fixture.run_id,
    threadTs: args.fixture.thread_ts,
    channelStateRef: args.channelStateRef,
  });
  const originalSubscribe = thread.subscribe.bind(thread);
  thread.subscribe = async () => {
    await originalSubscribe();
    await args.stateAdapter.subscribe(thread.id);
  };
  const originalUnsubscribe = thread.unsubscribe.bind(thread);
  thread.unsubscribe = async () => {
    await originalUnsubscribe();
    await args.stateAdapter.unsubscribe(thread.id);
  };
  thread.isSubscribed = async () =>
    await args.stateAdapter.isSubscribed(thread.id);
  return thread;
}

/**
 * Record thread posts not yet in the session.
 *
 * TestThread includes SDK and Slack HTTP posts. Read each once before the
 * next user message so the judge sees the delivery order.
 */
export function recordPendingPosts(
  records: Map<string, EvalThreadRecord>,
  observations: RuntimeObservations,
): void {
  for (const record of records.values()) {
    const posts = record.thread.posts;
    for (const post of posts.slice(record.recordedPosts)) {
      recordAssistantPost(
        observations,
        record.thread,
        toEvalAssistantPost(post),
      );
    }
    record.recordedPosts = posts.length;
  }
}

/** Append one inbound user message to the normalized session. */
export function recordUserMessage(
  observations: RuntimeObservations,
  event: MentionEvent | SubscribedMessageEvent,
): void {
  const author = event.message.author;
  const authorName =
    author?.full_name?.trim() ||
    author?.user_name?.trim() ||
    author?.user_id?.trim();
  observations.sessionMessages.push({
    role: "user",
    content: event.message.text ?? "",
    metadata: {
      event_type: event.type,
      ...(authorName ? { author_name: authorName } : {}),
      ...(event.thread.channel_id ? { channel: event.thread.channel_id } : {}),
      ...(event.thread.thread_ts ? { thread_ts: event.thread.thread_ts } : {}),
    },
  });
}

function recordAssistantPost(
  observations: RuntimeObservations,
  thread: TestThread,
  post: EvalAssistantPost,
): void {
  observations.sessionMessages.push({
    role: "assistant",
    content: post.text,
    metadata: {
      event_type: post.eventType ?? "thread_post",
      channel: thread.channelId,
      ...(thread.threadTs ? { thread_ts: thread.threadTs } : {}),
      files: post.files.map((file) => ({
        filename: file.filename,
        isImage: file.isImage,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      })),
    },
  });
}

/**
 * Build a Chat SDK Message for Slack ingress from a harness event.
 *
 * Synthetic Slack ingress keeps an empty formatted AST so plain text remains
 * the source of truth, matching mailbox restore elsewhere in Junior.
 */
export function toSlackMessage(
  event: MentionEvent | SubscribedMessageEvent,
  threadId: string,
  dateSentMs: number = Date.now(),
): Message {
  // In Slack payloads, `ts` identifies the specific message while `thread_ts`
  // identifies the thread root. Fixtures provide unique `message.id` per
  // event, so prefer it for `raw.ts` to avoid collapsing all replies to the
  // same timestamp in multi-turn thread scenarios.
  const messageTs = event.message.id ?? event.thread.thread_ts;
  return new ChatMessage({
    id: event.message.id ?? "",
    threadId,
    text: event.message.text ?? "",
    isMention: event.message.is_mention,
    attachments: [],
    // Empty root keeps plain text authoritative for synthetic ingress.
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(dateSentMs), edited: false },
    raw: {
      ...(event.message.raw ?? {}),
      channel: event.thread.channel_id,
      ...(event.thread.channel_type
        ? { channel_type: event.thread.channel_type }
        : {}),
      team_id: EVAL_SLACK_TEAM_ID,
      ts: messageTs,
      thread_ts: event.thread.thread_ts,
    },
    author: {
      userId: event.message.author?.user_id ?? "U-eval",
      userName: event.message.author?.user_name ?? "",
      fullName: event.message.author?.full_name ?? "",
      isMe: event.message.author?.is_me ?? false,
      isBot: event.message.author?.is_bot ?? false,
    },
  });
}

/** Insert or replace a message in a thread transcript by id. */
export function upsertThreadTranscriptMessage(
  transcript: Message[],
  message: Message,
): void {
  const existingIndex = transcript.findIndex(
    (entry) => entry.id === message.id,
  );
  if (existingIndex >= 0) {
    transcript[existingIndex] = message;
    return;
  }
  transcript.push(message);
}

/** Project a transcript message into the Slack thread reply shape. */
export function buildThreadReplyFromMessage(
  threadTs: string | undefined,
  message: Message,
): EvalSlackThreadReply {
  return {
    ts: message.id,
    user: message.author.userId,
    text: message.text,
    thread_ts: threadTs,
    ...(message.author.isBot ? { bot_id: message.author.userId } : {}),
  };
}
