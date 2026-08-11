import type {
  Adapter,
  Author,
  ChatElement,
  Channel,
  PostableMessage,
  PostableObject,
  ScheduledMessage,
  SentMessage,
  Thread,
} from "chat";
import { isPostableObject, Message } from "chat";
import { SlackAdapter } from "@chat-adapter/slack";
import type { Destination } from "@sentry/junior-plugin-api";

// ── Helpers ──────────────────────────────────────────────────────────

function parseChannelFromThreadId(threadId: string): string | undefined {
  const parts = threadId.split(":");
  if (parts.length === 3 && parts[0] === "slack" && parts[1]) return parts[1];
  return undefined;
}

function parseChannelFromAdapterChannelId(
  channelId: string | undefined,
): string | undefined {
  if (!channelId) return undefined;
  const parts = channelId.split(":");
  if (parts.length === 2 && parts[0] === "slack" && parts[1]) return parts[1];
  return channelId;
}

function toAdapterChannelId(threadId: string): string | undefined {
  const channelId = parseChannelFromThreadId(threadId);
  return channelId ? `slack:${channelId}` : undefined;
}

export const TEST_SLACK_TEAM_ID = "TTEST";

export function createTestDestination(
  thread: Pick<Thread, "channelId" | "id">,
): Destination {
  const channelId =
    parseChannelFromThreadId(thread.id) ??
    parseChannelFromAdapterChannelId(thread.channelId);
  if (!channelId) {
    throw new Error("Test Slack destination requires a Slack channel id");
  }
  return {
    platform: "slack",
    teamId: TEST_SLACK_TEAM_ID,
    channelId,
  };
}

// ── Test Author ──────────────────────────────────────────────────────

const defaultAuthor: Author = {
  userId: "U-test",
  userName: "testuser",
  fullName: "Test User",
  isBot: false,
  isMe: false,
};

export function createTestAuthor(overrides?: Partial<Author>): Author {
  return { ...defaultAuthor, ...overrides };
}

// ── Test Message ─────────────────────────────────────────────────────

export interface SlackRawMessage {
  channel?: string;
  event_ts?: string;
  thread_ts?: string;
  ts?: string;
  [key: string]: unknown;
}

/** Create a Chat SDK message with fixed Slack data. */
export function createTestMessage(args: {
  text?: string;
  id?: string;
  threadId?: string;
  author?: Partial<Author>;
  isMention?: boolean;
  attachments?: Message["attachments"];
  dateSent?: Date;
  formatted?: Message["formatted"];
  raw?: SlackRawMessage;
}): Message<SlackRawMessage> {
  const threadId = args.threadId ?? "slack:C0TEST:1700000000.000";
  const threadParts = threadId.split(":");
  const inferredChannel = threadParts.length === 3 ? threadParts[1] : undefined;
  const inferredTs = threadParts.length === 3 ? threadParts[2] : undefined;
  return new Message({
    id: args.id ?? "msg-1",
    threadId,
    text: args.text ?? "hello",
    author: createTestAuthor(args.author),
    isMention: args.isMention,
    attachments: args.attachments ?? [],
    metadata: { dateSent: args.dateSent ?? new Date(), edited: false },
    formatted: args.formatted ?? { type: "root", children: [] },
    raw: args.raw ?? {
      ...(inferredChannel ? { channel: inferredChannel } : {}),
      ...(inferredTs ? { ts: inferredTs, thread_ts: inferredTs } : {}),
    },
  });
}

function createTestSentMessage<TRawMessage>(
  message: Message<TRawMessage>,
  callbacks: {
    onDelete?: () => void;
    onEdit?: (value: unknown) => void;
  } = {},
): SentMessage<TRawMessage> {
  let sentMessage: SentMessage<TRawMessage>;
  const methods: Pick<
    SentMessage<TRawMessage>,
    "addReaction" | "delete" | "edit" | "removeReaction"
  > = {
    async addReaction() {},
    async delete() {
      callbacks.onDelete?.();
    },
    async edit(newContent) {
      message.text = postedText(newContent);
      callbacks.onEdit?.(newContent);
      return sentMessage;
    },
    async removeReaction() {},
  };
  sentMessage = Object.assign(message, methods);
  return sentMessage;
}

function postedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "markdown" in value) {
    const { markdown } = value as { markdown?: unknown };
    if (typeof markdown === "string") {
      return markdown;
    }
  }
  return String(value);
}

function createSchedule(channelId: string): Thread["schedule"] {
  return async (_message, options): Promise<ScheduledMessage> => ({
    scheduledMessageId: "scheduled-1",
    channelId,
    postAt: options.postAt,
    raw: {},
    async cancel() {},
  });
}

function createPost(args: {
  adapter: Adapter;
  record?: (
    value: unknown,
    kind: "stream" | "value",
  ) => {
    id: string;
    onDelete: () => void;
    onEdit: (value: unknown) => void;
  };
  threadId: string;
}): Thread["post"] {
  function post<T extends PostableObject>(message: T): Promise<T>;
  function post(
    message: string | PostableMessage | ChatElement,
  ): Promise<SentMessage>;
  async function post(message: unknown): Promise<unknown> {
    if (isPostableObject(message)) {
      const recorded = args.record?.(message, "value");
      message.onPosted({
        adapter: args.adapter,
        messageId: recorded?.id ?? "sent-1",
        threadId: args.threadId,
      });
      return message;
    }

    let value = message;
    let kind: "stream" | "value" = "value";
    if (
      message &&
      typeof message === "object" &&
      Symbol.asyncIterator in message
    ) {
      kind = "stream";
      let text = "";
      for await (const chunk of message as AsyncIterable<string>) {
        text += chunk;
      }
      value = text;
    }

    const recorded = args.record?.(value, kind);
    return createTestSentMessage(
      createTestMessage({
        id: recorded?.id ?? "sent-1",
        text: postedText(value),
        threadId: args.threadId,
      }),
      recorded,
    );
  }
  return post;
}

// ── Fake Slack Adapter ───────────────────────────────────────────────

export class FakeSlackAdapter extends SlackAdapter {
  // Providing a bot user id opts this fixture into single-workspace install
  // mode: runWithSlackInstallation requires defaultBotTokenProvider (and a
  // resolved bot user id) before it runs worker-claimed Slack turns. Leaving
  // it unset keeps the legacy behavior, including generic leading-mention
  // stripping instead of exact bot-id stripping.
  constructor(options?: { botUserId?: string }) {
    super(
      options?.botUserId
        ? {
            botToken: "xoxb-test-token",
            botUserId: options.botUserId,
          }
        : {},
    );
  }

  readonly statusCalls: Array<{
    channelId: string;
    threadTs: string;
    text: string;
    loadingMessages?: string[];
  }> = [];
  readonly promptCalls: Array<{
    channelId: string;
    prompts: Array<{ message: string; title: string }>;
    threadTs: string;
  }> = [];
  readonly titleCalls: Array<{
    channelId: string;
    threadTs: string;
    title: string;
  }> = [];

  override async initialize(): Promise<void> {}

  override async setAssistantTitle(
    channelId: string,
    threadTs: string,
    title: string,
  ): Promise<void> {
    this.titleCalls.push({ channelId, threadTs, title });
  }

  override async setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: Array<{ message: string; title: string }>,
  ): Promise<void> {
    this.promptCalls.push({ channelId, threadTs, prompts });
  }

  override async setAssistantStatus(
    channelId: string,
    threadTs: string,
    text: string,
    loadingMessages?: string[],
  ): Promise<void> {
    this.statusCalls.push({ channelId, threadTs, text, loadingMessages });
  }
}

function createThreadAdapter(): Adapter {
  const adapter = new FakeSlackAdapter();
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "name") {
        return "test";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ── Test Thread ──────────────────────────────────────────────────────

export interface TestThread extends Thread {
  posts: unknown[];
  postKinds: Array<"stream" | "value">;
  runId?: string;
  subscribeCalls: number;
  subscribed: boolean;
  threadTs?: string;
  /** Load scratch from the same Junior adapter path production uses. */
  getState: () => Promise<Record<string, unknown>>;
}

function threadStateKey(threadId: string): string {
  return `thread-state:${threadId}`;
}

function channelStateKey(channelId: string): string {
  return `channel-state:${channelId}`;
}

async function getJuniorStateAdapter() {
  // Dynamic import so harness reads survive vi.resetModules() in integration
  // fixtures that reload env/config between agent instances.
  const { getStateAdapter } = await import("@/chat/state/adapter");
  return getStateAdapter();
}

async function readAdapterState(
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const stateAdapter = await getJuniorStateAdapter();
  await stateAdapter.connect();
  return (await stateAdapter.get<Record<string, unknown>>(key)) ?? undefined;
}

async function writeAdapterState(
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const { JUNIOR_THREAD_STATE_TTL_MS } = await import("@/chat/state/ttl");
  const stateAdapter = await getJuniorStateAdapter();
  await stateAdapter.connect();
  await stateAdapter.set(key, value, JUNIOR_THREAD_STATE_TTL_MS);
}

async function deleteAdapterState(key: string): Promise<void> {
  const stateAdapter = await getJuniorStateAdapter();
  await stateAdapter.connect();
  await stateAdapter.delete(key);
}

export async function createTestThread(args: {
  id?: string;
  channelId?: string;
  state?: Record<string, unknown>;
  channelStateRef?: { value: Record<string, unknown> };
  runId?: string;
  threadTs?: string;
}): Promise<TestThread> {
  const id = args.id ?? "slack:C0TEST:1700000000.000";
  const channelId = args.channelId ?? toAdapterChannelId(id) ?? id;
  // Local cache for fixture seeding before the first adapter round-trip. Reads
  // prefer the Junior adapter so production writes are visible to tests.
  let stateData: Record<string, unknown> = { ...(args.state ?? {}) };
  const posts: unknown[] = [];
  const postKinds: Array<"stream" | "value"> = [];
  const postIds: symbol[] = [];
  let subscribeCalls = 0;
  let subscribed = false;
  let seededThreadState = false;
  let seededChannelState = false;

  const stubAdapter = createThreadAdapter();
  const channelRef = args.channelStateRef ?? { value: {} };

  // Constructor args own the fixture snapshot for this id. Always apply them so
  // reused thread ids do not inherit leftover adapter scratch from a prior case.
  // Empty constructor state means start clean.
  const seedThreadState = async (): Promise<void> => {
    if (seededThreadState) {
      return;
    }
    const key = threadStateKey(id);
    if (Object.keys(stateData).length === 0) {
      await deleteAdapterState(key);
    } else {
      await writeAdapterState(key, stateData);
    }
    seededThreadState = true;
  };

  const loadThreadState = async (): Promise<Record<string, unknown>> => {
    await seedThreadState();
    const stored = await readAdapterState(threadStateKey(id));
    if (stored) {
      stateData = stored;
      return stored;
    }
    return stateData;
  };

  // Channel ids are shared across threads. Only apply constructor channel state
  // when the fixture explicitly seeded it. Never wipe adapter channel scratch
  // from an empty default ref — production config writes may already live there.
  const seedChannelState = async (): Promise<void> => {
    if (seededChannelState) {
      return;
    }
    if (Object.keys(channelRef.value).length > 0) {
      await writeAdapterState(channelStateKey(channelId), channelRef.value);
    }
    seededChannelState = true;
  };

  const loadChannelState = async (): Promise<Record<string, unknown>> => {
    await seedChannelState();
    const stored = await readAdapterState(channelStateKey(channelId));
    if (stored) {
      channelRef.value = stored;
      return stored;
    }
    return channelRef.value;
  };

  const channel: Channel = {
    adapter: stubAdapter,
    id: channelId,
    isDM: false,
    channelVisibility: "unknown",
    get messages(): AsyncIterable<Message> {
      return (async function* () {})();
    },
    get name() {
      return null;
    },
    mentionUser(userId: string) {
      return `<@${userId}>`;
    },
    post: createPost({ adapter: stubAdapter, threadId: channelId }),
    async postEphemeral() {
      return null;
    },
    schedule: createSchedule(channelId),
    get state(): Promise<Record<string, unknown>> {
      return loadChannelState();
    },
    async setState(
      next: Partial<Record<string, unknown>>,
      options?: { replace?: boolean },
    ): Promise<void> {
      const current = options?.replace ? {} : await loadChannelState();
      channelRef.value = {
        ...current,
        ...(next as Record<string, unknown>),
      };
      seededChannelState = true;
      await writeAdapterState(channelStateKey(channelId), channelRef.value);
    },
    async startTyping(): Promise<void> {},
    async fetchMetadata() {
      return {
        id: channelId,
        metadata: {},
      };
    },
    threads(): AsyncIterable<never> {
      return (async function* () {})();
    },
    toJSON() {
      return {
        _type: "chat:Channel" as const,
        adapterName: stubAdapter.name,
        id: channelId,
        isDM: false,
      };
    },
  } satisfies Channel;

  const thread: TestThread = {
    adapter: stubAdapter,
    id,
    channelId,
    runId: args.runId,
    threadTs: args.threadTs,
    isDM: false,
    channelVisibility: "unknown",
    channel,
    get allMessages(): AsyncIterable<Message> {
      return (async function* () {})();
    },
    get messages(): AsyncIterable<Message> {
      return (async function* () {})();
    },
    recentMessages: [],
    get state(): Promise<Record<string, unknown>> {
      return loadThreadState();
    },
    post: createPost({
      adapter: stubAdapter,
      threadId: id,
      record(entry, kind) {
        const postId = Symbol("post");
        posts.push(entry);
        postKinds.push(kind);
        postIds.push(postId);
        return {
          id: `sent-${posts.length}`,
          onDelete() {
            const idx = postIds.indexOf(postId);
            if (idx === -1) return;
            posts.splice(idx, 1);
            postKinds.splice(idx, 1);
            postIds.splice(idx, 1);
          },
          onEdit(value) {
            const idx = postIds.indexOf(postId);
            if (idx === -1) return;
            posts[idx] = value;
            postKinds[idx] = "value";
          },
        };
      },
    }),
    async postEphemeral() {
      return null;
    },
    schedule: createSchedule(channelId),
    async startTyping(): Promise<void> {},
    async subscribe(): Promise<void> {
      subscribed = true;
      subscribeCalls += 1;
    },
    async unsubscribe(): Promise<void> {
      subscribed = false;
    },
    async isSubscribed(): Promise<boolean> {
      return subscribed;
    },
    async refresh(): Promise<void> {},
    mentionUser(userId: string): string {
      return `<@${userId}>`;
    },
    async setState(
      next: Partial<Record<string, unknown>>,
      options?: { replace?: boolean },
    ): Promise<void> {
      const current = options?.replace ? {} : await loadThreadState();
      stateData = {
        ...current,
        ...(next as Record<string, unknown>),
      };
      seededThreadState = true;
      await writeAdapterState(threadStateKey(id), stateData);
    },
    createSentMessageFromMessage(message: Message): SentMessage {
      return createTestSentMessage(message);
    },
    async getParticipants(): Promise<Author[]> {
      return [];
    },
    get posts() {
      return posts;
    },
    get postKinds() {
      return postKinds;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get subscribed() {
      return subscribed;
    },
    getState() {
      return loadThreadState();
    },
    toJSON() {
      return {
        _type: "chat:Thread" as const,
        adapterName: stubAdapter.name,
        id,
        channelId,
        isDM: false,
      };
    },
  };

  // Production reads scratch via the Junior adapter, not thread.state. Await the
  // seed so the first prepareTurnState sees constructor-provided state.
  await seedThreadState();
  await seedChannelState();

  return thread;
}

// ── Compile-time guards ──────────────────────────────────────────────
// Ensure fakes stay in sync with the Chat SDK types. If the SDK adds a
// required property, typecheck will fail here rather than silently at runtime.
type AssertAssignable<_TSub extends TSuper, TSuper> = true;

type _ThreadCheck = AssertAssignable<TestThread, Thread>;

// Prevent unused-type warnings
const threadCheck: _ThreadCheck = true;
void threadCheck;
