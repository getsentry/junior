/**
 * One Junior app for one test, driven only through its routes.
 *
 * The agent, the model, Guardian, the turn router, titles, the reply policy,
 * compaction, Postgres, and Redis are real. Slack and other third-party APIs
 * are MSW mocks. The fixture replaces only the Vercel Queue transport and
 * `waitUntil` with in-process versions, so it knows when the agent is idle.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { assert } from "vitest";
import type { HarnessRun, TranscriptEvent } from "vitest-evals/harness";
import { createApp, type JuniorAppOptions } from "@/app";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { acceptedConversationMessageSchema } from "@/api/schema";
import { forkConversationResponseSchema } from "@/api/schema";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { readCapturedSlackApiCalls } from "@junior-tests/msw/captured-slack-api-calls";
import { runEvalWork } from "../eval-work";
import { installGatewayObserver, type GatewayProgress } from "./gateway";
import type { HistoryItem, HistoryReply, Input, SlackAuthor } from "./inputs";
import {
  hasHistory,
  loadHistory,
  WEB_VIEWER_EMAIL,
  type LoadedConversation,
} from "./history";
import {
  JUDGE_THRESHOLD,
  judgeReplies,
  type Rubric,
  type VisibleMessage,
} from "./judge";
import { createInProcessQueue } from "./queue";
import type { RecordedConversation } from "./recorded";
import {
  BEFORE_FIRST_EVENT,
  lastEventSeq,
  readCallEvents,
  readConversationDetail,
  VIEWER_HEADER,
  type Reply,
  type ToolCall,
  type Turn,
} from "./results";
import {
  DEFAULT_SLACK_AUTHOR,
  installSlackMock,
  postSlackMessageEvent,
  slackAuthorEmail,
  SLACK_BOT_USER_ID,
  type RequestApp,
  type SlackPost,
} from "./slack";

/** Every call fails when the agent is not idle within this budget. */
const IDLE_TIMEOUT_MS = 60_000;

export type TurnProgress = GatewayProgress | { type: "reply"; text: string };

export interface CallOptions {
  criteria?: Rubric;
  /** Earlier turns as items, or a recorded conversation. */
  history?: HistoryItem[] | RecordedConversation;
  onProgress?: (
    progress: TurnProgress,
    actions: { send(input: Input): Promise<void> },
  ) => void | Promise<void>;
}

/** Returned by every call. The fields describe that call only. */
export interface Conversation {
  conversationId: string;
  /** Assistant messages that people saw. */
  replies: Reply[];
  /** Tool calls of the agent, with their results. */
  toolCalls: ToolCall[];
  /** Slack reactions that Junior added. */
  reactions: string[];
  turns: Turn[];
  /** The vitest-evals run, for `toSatisfyJudge()` and other judges. */
  evalRun: HarnessRun;
  continue(
    input: Input | Input[],
    options?: CallOptions,
  ): Promise<Conversation>;
  fork(reply: Reply | HistoryReply): Promise<Conversation>;
}

export type RunAgent = (
  input: Input | Input[],
  options?: CallOptions,
) => Promise<Conversation>;

/** Test hooks the fixture needs from Vitest. */
export interface FixtureTestContext {
  signal: AbortSignal;
  task: {
    meta: {
      eval?: unknown;
      harness?: { name: string; run: HarnessRun };
    };
  };
}

/** What the fixture knows about one Conversation of the test. */
type ConversationRecord = LoadedConversation & {
  /** Last event seen by an earlier call or by history loading. */
  lastSeq: number;
  /** The person who started the Conversation reads its results. */
  viewerEmail: string;
  /** User-visible messages so far, for the judge's context. */
  visibleMessages: VisibleMessage[];
};

export interface FixtureAgent {
  /** Stop new deliveries and wait for running work. */
  close(): Promise<void>;
  run: RunAgent;
}

/** Create the Junior app for one test and the calls that drive it. */
export async function createFixtureAgent(
  options: JuniorAppOptions,
  context: FixtureTestContext,
): Promise<FixtureAgent> {
  const queue = createInProcessQueue();
  const background = new Set<Promise<unknown>>();
  const backgroundErrors: unknown[] = [];
  const track = (task: Promise<unknown>) => {
    const tracked = task.catch((error: unknown) => {
      backgroundErrors.push(error);
    });
    background.add(tracked);
    void tracked.finally(() => background.delete(tracked));
  };
  const slack = installSlackMock();
  const gateway = installGatewayObserver();
  const app = await createApp({
    ...options,
    conversationWorkQueue: (consume) => queue.connect(consume),
    waitUntil: (task) => track(typeof task === "function" ? task() : task),
  });
  // The dashboard mounts the same API after sign-in. Each request signs in
  // as the person in `x-fixture-viewer`, or as the web person by default.
  const api = new Hono<JuniorApiEnv>();
  api.use("*", async (request, next) => {
    const email = request.req.header(VIEWER_HEADER) ?? WEB_VIEWER_EMAIL;
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`No dashboard user for ${email}`);
    request.set("viewer", viewer);
    await next();
  });
  api.route("/", createJuniorApi({ conversationWorkQueue: queue }));

  const close = async (): Promise<void> => {
    queue.close();
    while (queue.pending().length > 0 || background.size > 0) {
      await Promise.allSettled([...queue.pending(), ...background]);
    }
  };

  const conversations = new Map<string, ConversationRecord>();
  const replyMessages = new WeakMap<HistoryReply, string>();
  const calls: Array<{ conversationId: string; events: TranscriptEvent[] }> =
    [];
  const startedAtMs = Date.now();

  const waitForIdle = async (): Promise<void> => {
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    for (;;) {
      const pending = [...queue.pending(), ...background];
      if (pending.length === 0) {
        // Let work that a finished delivery started reach the queue.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (queue.pending().length === 0 && background.size === 0) break;
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `The agent was not idle within ${IDLE_TIMEOUT_MS / 1000} seconds`,
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remainingMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const errors = [...queue.takeErrors(), ...backgroundErrors.splice(0)];
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent work failed");
    }
  };

  const sendInput = async (
    record: ConversationRecord,
    input: Input,
  ): Promise<void> => {
    if (input.kind === "web_message") {
      const response = await api.request(
        `/api/conversations/${encodeURIComponent(record.conversationId)}/messages`,
        jsonRequest({ idempotencyKey: randomUUID(), message: input.text }),
      );
      await expectAccepted(response);
      return;
    }
    if (record.surface !== "slack") {
      throw new Error("Slack input needs a Slack Conversation");
    }
    const author = slack.registerAuthor(input.author ?? DEFAULT_SLACK_AUTHOR);
    const ts = slack.nextTs();
    const mention = input.kind === "mention";
    const text = mention ? `<@${SLACK_BOT_USER_ID}> ${input.text}` : input.text;
    slack.addThreadMessage(record.channelId, {
      text,
      thread_ts: record.threadTs,
      ts,
      user: author.userId,
    });
    await postSlackMessageEvent(app, {
      channel: record.channelId,
      channelType: record.channelType,
      mention,
      text,
      threadTs: record.threadTs,
      ts,
      user: author.userId,
    });
  };

  const startConversation = async (
    input: Input,
    rootHistoryAuthor: SlackAuthor | undefined,
  ): Promise<{ record: ConversationRecord; sent: boolean }> => {
    if (input.kind === "thread_message") {
      throw new Error("run() needs mention() or webMessage() first");
    }
    if (input.kind === "web_message") {
      const response = await api.request(
        "/api/conversations",
        jsonRequest({ idempotencyKey: randomUUID(), message: input.text }),
      );
      const accepted = await expectAccepted(response);
      const record = newRecord({
        conversationId: accepted.conversationId,
        surface: "web",
      });
      return { record, sent: true };
    }
    const channelType = input.channelType ?? "channel";
    const channelId =
      input.channel?.channelId ?? slack.newChannelId(channelType);
    const threadTs = slack.nextTs();
    const rootAuthor = slack.registerAuthor(
      rootHistoryAuthor ?? input.author ?? DEFAULT_SLACK_AUTHOR,
    );
    const record = newRecord(
      {
        channelId,
        channelType,
        conversationId: `slack:${channelId}:${threadTs}`,
        surface: "slack",
        threadTs,
      },
      slackAuthorEmail(rootAuthor),
    );
    return { record, sent: false };
  };

  const newRecord = (
    loaded: LoadedConversation,
    viewerEmail = WEB_VIEWER_EMAIL,
  ): ConversationRecord => {
    const record = {
      ...loaded,
      lastSeq: BEFORE_FIRST_EVENT,
      viewerEmail,
      visibleMessages: [],
    };
    conversations.set(record.conversationId, record);
    return record;
  };

  const sendSlackRoot = async (
    record: ConversationRecord,
    input: Input,
  ): Promise<void> => {
    if (record.surface !== "slack" || input.kind !== "mention") return;
    // The first mention is the thread root.
    const author = slack.registerAuthor(input.author ?? DEFAULT_SLACK_AUTHOR);
    const text = `<@${SLACK_BOT_USER_ID}> ${input.text}`;
    slack.addThreadMessage(record.channelId, {
      text,
      thread_ts: record.threadTs,
      ts: record.threadTs,
      user: author.userId,
    });
    await postSlackMessageEvent(app, {
      channel: record.channelId,
      channelType: record.channelType,
      mention: true,
      text,
      ts: record.threadTs,
      user: author.userId,
    });
  };

  const call = async (
    record: ConversationRecord,
    send: () => Promise<void>,
    options: CallOptions,
  ): Promise<Conversation> => {
    const slackCallIndex = readCapturedSlackApiCalls().length;
    const slackPostIndex = slack.posts().length;
    const progressActions = {
      send: async (input: Input) => await sendInput(record, input),
    };
    if (options.onProgress) {
      const onProgress = options.onProgress;
      gateway.setProgressHook(
        async (progress) => await onProgress(progress, progressActions),
      );
      slack.setReplyHook(async (post) => {
        await onProgress({ type: "reply", text: post.text }, progressActions);
      });
    }
    try {
      await send();
      await waitForIdle();
    } catch (error) {
      // Work must not outlive the test and reach closed stores.
      await close();
      throw error;
    } finally {
      gateway.setProgressHook(undefined);
      slack.setReplyHook(undefined);
    }
    const detail = await readConversationDetail(
      api,
      record.conversationId,
      record.viewerEmail,
    );
    const events = readCallEvents({
      afterSeq: record.lastSeq,
      conversationId: record.conversationId,
      detail,
    });
    const earlier = [...record.visibleMessages];
    record.lastSeq = events.lastSeq;
    // Slack people see thread posts, including posts Junior does not store,
    // such as the opt-out acknowledgement.
    const { replies, visibleMessages } =
      record.surface === "slack"
        ? slackCallReplies({
            durable: events,
            posts: slack
              .posts()
              .slice(slackPostIndex)
              .filter(
                (post) =>
                  post.channel === record.channelId &&
                  post.threadTs === record.threadTs,
              ),
            conversationId: record.conversationId,
          })
        : { replies: events.replies, visibleMessages: events.visibleMessages };
    record.visibleMessages.push(...visibleMessages);
    // Slack reactions are sets; ingress and the worker can add the same one.
    const reactions = [
      ...new Set(
        readCapturedSlackApiCalls()
          .slice(slackCallIndex)
          .flatMap((captured) =>
            captured.method === "reactions.add" &&
            record.surface === "slack" &&
            captured.params.channel === record.channelId &&
            typeof captured.params.name === "string"
              ? [`${String(captured.params.timestamp)}:${captured.params.name}`]
              : [],
          ),
      ),
    ].map((key) => key.slice(key.indexOf(":") + 1));
    const evalRun = toHarnessRun({
      conversationId: record.conversationId,
      gatewayRequests: gateway.requestCounts(),
      messages: visibleMessages,
      startedAtMs,
      toolCalls: events.toolCalls,
    });
    calls.push({
      conversationId: record.conversationId,
      events: evalRun.session.events,
    });
    context.task.meta.harness = {
      name: "junior",
      run: combinedRun(calls, gateway.requestCounts(), startedAtMs),
    };
    if (options.criteria) {
      const judged = await judgeReplies({
        criteria: options.criteria,
        current: visibleMessages,
        earlier,
        signal: context.signal,
      });
      context.task.meta.eval = {
        avgScore: judged.score,
        scores: [
          {
            name: "RubricJudge",
            score: judged.score,
            metadata: { answer: judged.answer, rationale: judged.rationale },
          },
        ],
        thresholdFailed: judged.score < JUDGE_THRESHOLD,
      };
      assert(
        judged.score >= JUDGE_THRESHOLD,
        `Rubric score ${judged.score} is below ${JUDGE_THRESHOLD}: ${judged.rationale}`,
      );
    }
    return conversationResult(record, {
      evalRun,
      reactions,
      replies,
      toolCalls: events.toolCalls,
      turns: events.turns,
    });
  };

  const sendInputs = async (
    record: ConversationRecord,
    inputs: Input[],
  ): Promise<void> => {
    // Inputs in one call arrive before the worker runs, as one batch.
    if (inputs.length > 1) queue.hold();
    try {
      for (const input of inputs) {
        await sendInput(record, input);
      }
    } finally {
      queue.release();
    }
  };

  const conversationResult = (
    record: ConversationRecord,
    result: Omit<Conversation, "continue" | "conversationId" | "fork">,
  ): Conversation => ({
    conversationId: record.conversationId,
    ...result,
    continue: (input, callOptions = {}) =>
      runEvalWork(async () => {
        if (hasHistory(callOptions.history)) {
          record.lastSeq = await loadHistory({
            api,
            conversation: record,
            items: callOptions.history,
            replyMessages,
            slack,
            viewerEmail: record.viewerEmail,
          });
        }
        const inputs = Array.isArray(input) ? input : [input];
        return await call(
          record,
          async () => await sendInputs(record, inputs),
          callOptions,
        );
      }),
    fork: (forkReply) =>
      runEvalWork(async () => {
        const messageId =
          "messageId" in forkReply
            ? forkReply.messageId
            : replyMessages.get(forkReply);
        if (!messageId) {
          throw new Error("fork() needs a reply from this test");
        }
        const response = await api.request(
          `/api/conversations/${encodeURIComponent(record.conversationId)}/forks`,
          jsonRequest({ idempotencyKey: randomUUID(), messageId }),
        );
        if (response.status !== 200) {
          throw new Error(
            `Fork returned ${response.status}: ${await response.text()}`,
          );
        }
        const forked = forkConversationResponseSchema.parse(
          await response.json(),
        );
        const forkRecord = newRecord({
          conversationId: forked.conversationId,
          surface: "web",
        });
        const detail = await readConversationDetail(
          api,
          forkRecord.conversationId,
          forkRecord.viewerEmail,
        );
        forkRecord.lastSeq = lastEventSeq(detail);
        forkRecord.visibleMessages = readCallEvents({
          afterSeq: BEFORE_FIRST_EVENT,
          conversationId: forkRecord.conversationId,
          detail,
        }).visibleMessages;
        return conversationResult(forkRecord, {
          evalRun: toHarnessRun({
            conversationId: forkRecord.conversationId,
            gatewayRequests: gateway.requestCounts(),
            messages: [],
            startedAtMs,
            toolCalls: [],
          }),
          reactions: [],
          replies: [],
          toolCalls: [],
          turns: [],
        });
      }),
  });

  const run: RunAgent = async (input, callOptions = {}) => {
    const inputs = Array.isArray(input) ? input : [input];
    const [first, ...rest] = inputs;
    if (!first) throw new Error("run() needs an input");
    if (hasHistory(callOptions.history) && first.kind === "web_message") {
      // Loaded history needs the Conversation before its first input.
      const record = newRecord({
        conversationId: `local:web:${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        surface: "web",
      });
      record.lastSeq = await loadHistory({
        api,
        conversation: record,
        items: callOptions.history,
        replyMessages,
        slack,
        viewerEmail: record.viewerEmail,
      });
      return await call(
        record,
        async () => await sendInputs(record, inputs),
        callOptions,
      );
    }
    const historyRoot = Array.isArray(callOptions.history)
      ? callOptions.history[0]
      : undefined;
    const { record, sent } = await startConversation(
      first,
      historyRoot &&
        historyRoot.kind !== "reply" &&
        historyRoot.kind !== "web_message"
        ? (historyRoot.author ?? DEFAULT_SLACK_AUTHOR)
        : undefined,
    );
    if (hasHistory(callOptions.history)) {
      record.lastSeq = await loadHistory({
        api,
        conversation: record,
        items: callOptions.history,
        replyMessages,
        slack,
        viewerEmail: record.viewerEmail,
      });
    }
    return await call(
      record,
      async () => {
        if (!sent && record.surface === "slack") {
          if (hasHistory(callOptions.history)) {
            await sendInputs(record, inputs);
          } else {
            if (rest.length > 0) queue.hold();
            try {
              await sendSlackRoot(record, first);
              for (const next of rest) await sendInput(record, next);
            } finally {
              queue.release();
            }
          }
        } else if (rest.length > 0) {
          await sendInputs(record, rest);
        }
      },
      callOptions,
    );
  };

  return { run, close };
}

function comparableText(text: string): string {
  return text
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Use Slack thread posts as the replies of a Slack call. A post that matches
 * a stored reply keeps the stored message id, so `fork()` can use it.
 */
function slackCallReplies(args: {
  conversationId: string;
  durable: { replies: Reply[]; visibleMessages: VisibleMessage[] };
  posts: SlackPost[];
}): { replies: Reply[]; visibleMessages: VisibleMessage[] } {
  const unmatched = [...args.durable.replies];
  const extra: VisibleMessage[] = [];
  const replies = args.posts.map((post): Reply => {
    const index = unmatched.findIndex(
      (reply) => comparableText(reply.text) === comparableText(post.text),
    );
    const durable = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
    if (!durable) extra.push({ content: post.text, role: "assistant" });
    return {
      conversationId: args.conversationId,
      messageId: durable?.messageId ?? `slack:${post.ts}`,
      text: post.text,
    };
  });
  return {
    replies,
    visibleMessages: [...args.durable.visibleMessages, ...extra],
  };
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function expectAccepted(response: Response) {
  if (response.status !== 200) {
    throw new Error(
      `Web message returned ${response.status}: ${await response.text()}`,
    );
  }
  return acceptedConversationMessageSchema.parse(await response.json());
}

function toTranscriptEvents(
  messages: VisibleMessage[],
  toolCalls: ToolCall[],
): TranscriptEvent[] {
  return [
    ...messages.map(
      (message): TranscriptEvent => ({
        type: "message",
        role: message.role,
        content: message.content,
        ...(message.author
          ? { metadata: { author_name: message.author } }
          : undefined),
      }),
    ),
    ...toolCalls.flatMap((toolCall): TranscriptEvent[] => [
      {
        type: "tool_call",
        id: toolCall.toolCallId,
        name: toolCall.name,
        ...(isJsonObject(toolCall.input)
          ? { arguments: toolCall.input }
          : undefined),
      },
      ...(toolCall.status === "running"
        ? []
        : [
            {
              type: "tool_result" as const,
              toolCallId: toolCall.toolCallId,
              name: toolCall.name,
              ...(toolCall.status === "error"
                ? { error: { message: JSON.stringify(toolCall.output ?? "") } }
                : {
                    content: JSON.parse(
                      JSON.stringify(toolCall.output ?? null),
                    ),
                  }),
            },
          ]),
    ]),
  ];
}

function isJsonObject(value: unknown): value is Record<string, never> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toHarnessRun(args: {
  conversationId: string;
  gatewayRequests: Record<string, number>;
  messages: VisibleMessage[];
  startedAtMs: number;
  toolCalls: ToolCall[];
}): HarnessRun {
  return {
    session: {
      events: toTranscriptEvents(args.messages, args.toolCalls),
      metadata: { conversation_ids: [args.conversationId] },
    },
    usage: {
      toolCalls: args.toolCalls.length,
      metadata: { gatewayRequests: args.gatewayRequests },
    },
    timings: { totalMs: Date.now() - args.startedAtMs },
    errors: [],
  };
}

function combinedRun(
  calls: Array<{ conversationId: string; events: TranscriptEvent[] }>,
  gatewayRequests: Record<string, number>,
  startedAtMs: number,
): HarnessRun {
  return {
    session: {
      events: calls.flatMap((entry) => entry.events),
      metadata: {
        conversation_ids: [
          ...new Set(calls.map((entry) => entry.conversationId)),
        ],
      },
    },
    usage: { metadata: { gatewayRequests } },
    timings: { totalMs: Date.now() - startedAtMs },
    errors: [],
  };
}
