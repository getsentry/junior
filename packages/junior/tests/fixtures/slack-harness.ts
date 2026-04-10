import type {
  Adapter,
  Author,
  Channel,
  Message,
  SentMessage,
  Thread,
} from "chat";

// ── Helpers ──────────────────────────────────────────────────────────

function parseChannelFromThreadId(threadId: string): string | undefined {
  const parts = threadId.split(":");
  if (parts.length === 3 && parts[0] === "slack" && parts[1]) return parts[1];
  return undefined;
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

export function createTestMessage(args: {
  text?: string;
  id?: string;
  threadId?: string;
  author?: Partial<Author>;
  isMention?: boolean;
  attachments?: Message["attachments"];
  raw?: Record<string, unknown>;
}): Message {
  const threadId = args.threadId ?? "slack:C_TEST:1700000000.000";
  const threadParts = threadId.split(":");
  const inferredChannel = threadParts.length === 3 ? threadParts[1] : undefined;
  const inferredTs = threadParts.length === 3 ? threadParts[2] : undefined;
  return {
    id: args.id ?? "msg-1",
    threadId,
    text: args.text ?? "hello",
    author: createTestAuthor(args.author),
    isMention: args.isMention,
    attachments: args.attachments ?? [],
    metadata: { dateSent: new Date(), edited: false },
    formatted: { type: "root", children: [] },
    raw: args.raw ?? {
      ...(inferredChannel ? { channel: inferredChannel } : {}),
      ...(inferredTs ? { ts: inferredTs, thread_ts: inferredTs } : {}),
    },
    toJSON() {
      return {} as ReturnType<Message["toJSON"]>;
    },
  } as unknown as Message;
}

// ── Fake Slack Adapter ───────────────────────────────────────────────

export class FakeSlackAdapter {
  readonly statusCalls: Array<{
    channelId: string;
    threadTs: string;
    text: string;
    suggestions?: string[];
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

  async setAssistantTitle(
    channelId: string,
    threadTs: string,
    title: string,
  ): Promise<void> {
    this.titleCalls.push({ channelId, threadTs, title });
  }

  async setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: Array<{ message: string; title: string }>,
  ): Promise<void> {
    this.promptCalls.push({ channelId, threadTs, prompts });
  }

  async setAssistantStatus(
    channelId: string,
    threadTs: string,
    text: string,
    suggestions?: string[],
  ): Promise<void> {
    this.statusCalls.push({ channelId, threadTs, text, suggestions });
  }
}

// ── Test Thread ──────────────────────────────────────────────────────

export interface TestThread extends Thread {
  posts: unknown[];
  postKinds: Array<"stream" | "value">;
  runId?: string;
  subscribeCalls: number;
  subscribed: boolean;
  threadTs?: string;
  getState: () => Record<string, unknown>;
}

export function createTestThread(args: {
  id?: string;
  channelId?: string;
  state?: Record<string, unknown>;
  channelStateRef?: { value: Record<string, unknown> };
  runId?: string;
  threadTs?: string;
}): TestThread {
  const id = args.id ?? "slack:C_TEST:1700000000.000";
  const channelId = args.channelId ?? parseChannelFromThreadId(id) ?? id;
  let stateData: Record<string, unknown> = { ...(args.state ?? {}) };
  const posts: unknown[] = [];
  const postKinds: Array<"stream" | "value"> = [];
  const postIds: string[] = [];
  let subscribeCalls = 0;
  let subscribed = false;

  const stubAdapter = {} as Adapter;
  const channelRef = args.channelStateRef ?? { value: {} };

  const resolvePost = async (
    message: unknown,
  ): Promise<{ entry: unknown; kind: "stream" | "value" }> => {
    if (
      message &&
      typeof message === "object" &&
      Symbol.asyncIterator in (message as Record<PropertyKey, unknown>)
    ) {
      let text = "";
      for await (const chunk of message as AsyncIterable<string>) {
        text += chunk;
      }
      return { entry: text, kind: "stream" };
    }

    return { entry: message, kind: "value" };
  };

  const createSentMessage = (messageId: string): SentMessage => {
    const sent = {
      id: messageId,
      get text() {
        const index = postIds.indexOf(messageId);
        return index === -1 ? "" : String(posts[index]);
      },
      async edit(message: unknown) {
        const index = postIds.indexOf(messageId);
        if (index === -1) {
          throw new Error(`Unknown sent message id: ${messageId}`);
        }
        const { entry, kind } = await resolvePost(message);
        posts[index] = entry;
        postKinds[index] = kind;
        return createSentMessage(messageId);
      },
      async delete() {
        const index = postIds.indexOf(messageId);
        if (index === -1) return;
        posts.splice(index, 1);
        postKinds.splice(index, 1);
        postIds.splice(index, 1);
      },
      async addReaction() {},
      async removeReaction() {},
    } as unknown as SentMessage;

    return sent;
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
    post: (async () => undefined) as unknown as Channel["post"],
    postEphemeral: (async () => null) as unknown as Channel["postEphemeral"],
    schedule: (async () => ({
      id: "scheduled-1",
      cancel: async () => undefined,
    })) as unknown as Channel["schedule"],
    get state(): Promise<Record<string, unknown>> {
      return Promise.resolve(channelRef.value);
    },
    async setState(
      next: Partial<Record<string, unknown>>,
      options?: { replace?: boolean },
    ): Promise<void> {
      if (options?.replace) {
        channelRef.value = { ...(next as Record<string, unknown>) };
        return;
      }
      channelRef.value = {
        ...channelRef.value,
        ...(next as Record<string, unknown>),
      };
    },
    async startTyping(): Promise<void> {},
    fetchMetadata: (async () => ({
      id: channelId,
      metadata: {},
    })) as unknown as Channel["fetchMetadata"],
    threads(): AsyncIterable<never> {
      return (async function* () {})();
    },
    toJSON() {
      return {
        _type: "chat:Channel" as const,
        adapterName: "test",
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
      return Promise.resolve(stateData);
    },
    async post(message: unknown): Promise<SentMessage> {
      const { entry, kind } = await resolvePost(message);
      const postId = `sent-${postIds.length + 1}`;
      posts.push(entry);
      postKinds.push(kind);
      postIds.push(postId);
      return createSentMessage(postId);
    },
    postEphemeral: (async () => null) as unknown as Thread["postEphemeral"],
    schedule: (async () => ({
      id: "scheduled-1",
      cancel: async () => undefined,
    })) as unknown as Thread["schedule"],
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
      if (options?.replace) {
        stateData = { ...(next as Record<string, unknown>) };
        return;
      }
      stateData = { ...stateData, ...(next as Record<string, unknown>) };
    },
    createSentMessageFromMessage(message: Message): SentMessage {
      return createSentMessage(message.id);
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
      return stateData;
    },
    toJSON() {
      return {
        _type: "chat:Thread" as const,
        adapterName: "test",
        id,
        channelId,
        isDM: false,
      };
    },
  };

  return thread;
}

// ── Compile-time guards ──────────────────────────────────────────────
// Ensure fakes stay in sync with the Chat SDK types. If the SDK adds a
// required property, typecheck will fail here rather than silently at runtime.
type AssertAssignable<_TSub extends TSuper, TSuper> = true;

type _ThreadCheck = AssertAssignable<TestThread, Thread>;

type _MessageCheck = AssertAssignable<
  ReturnType<typeof createTestMessage>,
  Message
>;

// Prevent unused-type warnings
void (0 as unknown as _ThreadCheck);
void (0 as unknown as _MessageCheck);
