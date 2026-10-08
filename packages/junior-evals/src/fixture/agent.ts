/**
 * One Junior app for one test, driven only through its routes.
 *
 * The agent, the model, Guardian, the turn router, titles, the reply policy,
 * compaction, Postgres, and Redis are real. Slack, Vercel Blob, and other
 * third-party APIs are MSW mocks. Other HTTP traffic goes through
 * Roach, the recording proxy, which replays model responses and the web pages that
 * `webFetch` reads. See `../recording-rules.ts`. The fixture replaces only the
 * Vercel Queue transports and `waitUntil` with in-process versions, so it
 * knows when the agent is idle.
 */
import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  serializeError,
  type HarnessRun,
  type TranscriptEvent,
} from "vitest-evals/harness";
import { createApp, type JuniorAppOptions } from "@/app";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { acceptedConversationMessageSchema } from "@/api/schema";
import { forkConversationResponseSchema } from "@/api/schema";
import {
  createConversationId,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { readCapturedSlackApiCalls } from "@junior-tests/msw/captured-slack-api-calls";
import { runEvalWork } from "../eval-work";
import { completeAuthorization, forgetAuthorizations } from "./auth";
import { installBlobMock } from "./blob";
import { installGatewayObserver, type GatewayProgress } from "./gateway";
import { fixtureId } from "./ids";
import { installWebReplay } from "./web";
import type {
  AutomationInput,
  FileInput,
  HistoryItem,
  HistoryReply,
  Input,
  MentionInput,
  MessageInput,
  ThreadMessageInput,
} from "./inputs";
import {
  hasHistory,
  loadHistory,
  WEB_VIEWER_EMAIL,
  type LoadedConversation,
} from "./history";
import type { VisibleMessage } from "./judge";
import { createInProcessQueue } from "./queue";
import type { RecordedConversation } from "./recorded";
import {
  BEFORE_FIRST_EVENT,
  combinedRun,
  readAuthorizationPrompt,
  readCallEvents,
  readConversationDetail,
  slackCallReplies,
  toHarnessRun,
  VIEWER_HEADER,
  type FixtureUsage,
  type Reply,
  type ToolCall,
  type Turn,
} from "./results";
import {
  DEFAULT_SLACK_AUTHOR,
  forwardedMessage,
  installSlackMock,
  isAppMention,
  postSlackAssistantThreadStarted,
  postSlackCommand,
  postSlackMessageEvent,
  slackAuthorEmail,
  SLACK_APP,
  SLACK_APP_BOT_ID,
  SLACK_BOT_USER_ID,
} from "./slack";

/**
 * Every call fails when the agent is not idle within this budget. The budget
 * does not include the time that a delivery waits for its delay.
 */
const IDLE_TIMEOUT_MS = 60_000;
/**
 * How long a model request waits after `onProgress` sent input. The product
 * checks for a stop every 500 ms and takes steering input at the next model
 * request. A replayed response comes back at once, so without this wait the
 * turn can go on before the product sees the input. A live model is slower,
 * so the recording run and the replay would take different paths.
 */
const INPUT_SETTLE_MS = 1_500;

export type TurnProgress = GatewayProgress | { type: "reply"; text: string };

export interface CallOptions {
  /** Earlier turns as items, or a recorded conversation. */
  history?: HistoryItem[] | RecordedConversation;
  onProgress?: (
    progress: TurnProgress,
    actions: { send(input: Input): Promise<void> },
  ) => void | Promise<void>;
}

/**
 * Returned by every call. The fields describe that call only. It is also the
 * vitest-evals run of the call, so `expect(conversation).toSatisfyJudge()`
 * takes it.
 */
export interface Conversation extends HarnessRun {
  conversationId: string;
  /** Assistant messages that people saw. */
  replies: Reply[];
  /** Tool calls of the agent, with their results. */
  toolCalls: ToolCall[];
  /** Slack reactions that Junior added. */
  reactions: string[];
  /** Names of the files that Junior uploaded to the Slack thread. */
  files: string[];
  /**
   * Status lines that Junior set under the Slack thread, in order. An empty
   * string clears the status.
   */
  statuses: string[];
  /** Titles that Junior gave the Slack thread, in order. */
  threadTitles: string[];
  /** The title that the dashboard shows after the call. */
  title: string;
  /**
   * The label of the connect prompt that the dashboard shows to the person
   * after the call, when a turn waits for their authorization.
   */
  authorizationPrompt?: string;
  /** Times Junior replaced agent history with a summary, as the dashboard shows. */
  compactions: number;
  turns: Turn[];
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
  task: {
    /** The file, describe blocks, and name of the test. */
    fullName: string;
    meta: {
      harness?: { name: string; run: HarnessRun };
    };
  };
}

/**
 * A Conversation that an automation started. Its replies are the Slack posts
 * of the call, and it takes no further input.
 */
type AutomationConversation = { conversationId: string; surface: "automation" };

/** What the fixture knows about one Conversation of the test. */
type ConversationRecord = (LoadedConversation | AutomationConversation) & {
  /** Key of the request that creates a web Conversation. */
  idempotencyKey: string;
  /** Whether an input or loaded history created the Conversation. */
  started: boolean;
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
  const slack = installSlackMock(context.task.fullName);
  const gateway = installGatewayObserver();
  const blob = await installBlobMock();
  installWebReplay();
  const app = await createApp({
    ...options,
    conversationWorkQueue: (consume) => queue.connect(consume),
    // Plugin tasks run in process. A call is idle only after they finish.
    pluginTaskQueue: (consume) => ({
      send: async (message) => track(consume(message)),
    }),
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

  let closed = false;
  const close = async (): Promise<void> => {
    queue.close();
    while (queue.pending().length > 0 || background.size > 0) {
      await Promise.allSettled([...queue.pending(), ...background]);
    }
    if (!closed) {
      closed = true;
      await blob.close();
      // Each Slack person is also a dashboard person with their email.
      await forgetAuthorizations([
        webActorFromEmail(WEB_VIEWER_EMAIL).userId,
        ...slack
          .authors()
          .flatMap((author) => [
            author.userId,
            webActorFromEmail(slackAuthorEmail(author)).userId,
          ]),
      ]);
    }
  };

  const replyMessages = new WeakMap<HistoryReply, string>();
  const knownConversationIds = new Set<string>();
  const calls: Array<{ conversationId: string; events: TranscriptEvent[] }> =
    [];
  // Agent model cost per Conversation, from the reporting API.
  const agentCostUsd = new Map<string, number>();
  const currentUsage = (): FixtureUsage => ({
    agentCostUsd: [...agentCostUsd.values()].reduce((a, b) => a + b, 0),
    gatewayRequests: gateway.requestCounts(),
  });
  const startedAtMs = Date.now();

  const waitForIdle = async (): Promise<void> => {
    const startedAtMs = Date.now();
    for (;;) {
      // The product delays some deliveries. For example, a watch delivery
      // waits 30 seconds for more events. The budget starts when the last
      // delivery is due to start.
      const deadline =
        Math.max(startedAtMs, queue.latestStartAtMs()) + IDLE_TIMEOUT_MS;
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

  const postAutomationInput = async (input: AutomationInput): Promise<void> => {
    const response = await app.request(automationRequest(input));
    if (response.status !== 202) {
      throw new Error(
        `${input.kind} returned ${response.status}: ${await response.text()}`,
      );
    }
  };

  /**
   * Post one input through its app route. The first web input creates the
   * Conversation, and the first Slack mention is the thread root.
   */
  const sendInput = async (
    record: ConversationRecord,
    input: Input,
  ): Promise<void> => {
    if (record.surface === "automation") {
      throw new Error("A Conversation from an automation takes no input");
    }
    if (isAutomationInput(input)) {
      // On a started Conversation, the automation input reaches its watches.
      if (!record.started) {
        throw new Error(`run(${input.kind}) starts its own Conversation`);
      }
      await postAutomationInput(input);
      return;
    }
    if (input.kind === "complete_auth") {
      // The dashboard shows the prompt of a turn that its person started.
      const prompt =
        input.author || input.link
          ? undefined
          : await readAuthorizationPrompt(
              api,
              record.conversationId,
              record.viewerEmail,
            );
      if (prompt) {
        await completeAuthorization({
          app,
          link: prompt.url,
          provider: input.provider,
          userId: webActorFromEmail(record.viewerEmail).userId,
        });
        return;
      }
      const { userId } = slack.registerAuthor(
        input.author ?? DEFAULT_SLACK_AUTHOR,
      );
      await completeAuthorization({
        app,
        link: slack
          .authorizationLinks({
            // In a direct message, Junior sends the link as a normal message.
            directMessageChannel:
              record.surface === "slack" && record.channelType === "im"
                ? record.channelId
                : undefined,
            userId,
          })
          .at(input.link === "first" ? 0 : -1),
        provider: input.provider,
        userId,
      });
      return;
    }
    if (input.kind === "slack_command") {
      if (record.surface !== "slack") {
        throw new Error("slackCommand() continues a Slack Conversation");
      }
      const { userId } = slack.registerAuthor(
        input.author ?? DEFAULT_SLACK_AUTHOR,
      );
      await postSlackCommand(app, {
        channel: record.channelId,
        text: input.text,
        user: userId,
      });
      return;
    }
    const started = record.started;
    record.started = true;
    if (input.kind === "web_message") {
      const path = started
        ? `/api/conversations/${encodeURIComponent(record.conversationId)}/messages`
        : "/api/conversations";
      await expectAccepted(
        await api.request(
          path,
          jsonRequest(record.viewerEmail, {
            idempotencyKey: started
              ? fixtureId("web-message", 32)
              : record.idempotencyKey,
            message: input.text,
            ...(input.images?.length
              ? { images: input.images.map(webImage) }
              : undefined),
          }),
        ),
      );
      return;
    }
    if (record.surface !== "slack") {
      throw new Error("Slack input needs a Slack Conversation");
    }
    if (!started && input.kind !== "mention") {
      throw new Error("A Slack Conversation starts with slackMention()");
    }
    const fromApp = input.kind === "mention" && input.fromApp;
    const author = slack.registerAuthor(
      fromApp ? SLACK_APP : (input.author ?? DEFAULT_SLACK_AUTHOR),
    );
    // The first message of an assistant thread is under the thread that
    // Slack started. Every other first message is the root of its thread.
    const inAssistantThread =
      !started && input.kind === "mention" && input.assistantThread === true;
    if (inAssistantThread) {
      await postSlackAssistantThreadStarted(app, {
        channel: record.channelId,
        threadTs: record.threadTs,
        user: author.userId,
      });
      await waitForIdle();
    }
    const inThread = started || inAssistantThread;
    const ts = inThread ? slack.nextTs() : record.threadTs;
    const mention = isAppMention(input, record.channelType);
    const text = mention ? `<@${SLACK_BOT_USER_ID}> ${input.text}` : input.text;
    const files = input.files?.length
      ? { files: input.files.map(slack.addFile) }
      : undefined;
    const forwarded = input.forwarded
      ? { attachments: [forwardedMessage(input.forwarded)] }
      : undefined;
    slack.addThreadMessage(record.channelId, {
      ...(fromApp ? { bot_id: SLACK_APP_BOT_ID } : undefined),
      ...forwarded,
      ...files,
      text,
      thread_ts: record.threadTs,
      ts,
      user: author.userId,
    });
    await postSlackMessageEvent(app, {
      channel: record.channelId,
      channelType: record.channelType,
      ...(fromApp ? { botId: SLACK_APP_BOT_ID } : undefined),
      ...forwarded,
      ...files,
      mention,
      text,
      ...(inThread ? { threadTs: record.threadTs } : undefined),
      ts,
      user: author.userId,
    });
  };

  /** Create the record for a new Conversation. It starts with its first input. */
  const newConversation = (
    first: MessageInput,
    history: CallOptions["history"],
  ): ConversationRecord => {
    if (first.kind === "web_message") {
      // The Conversation id comes from this key, and attachment ids come
      // from the Conversation id.
      const idempotencyKey = fixtureId("web-conversation", 32);
      return newRecord({
        conversationId: createConversationId({
          actorEmail: WEB_VIEWER_EMAIL,
          idempotencyKey,
        }),
        idempotencyKey,
        surface: "web",
      });
    }
    if (first.kind !== "mention" && !hasHistory(history)) {
      throw new Error("run() needs slackMention() or webMessage() first");
    }
    const mention = first.kind === "mention" ? first : undefined;
    if (mention?.assistantThread && mention.channelType === "channel") {
      throw new Error("An assistant thread is a direct message");
    }
    const channelType = mention?.assistantThread
      ? "im"
      : (mention?.channelType ?? "channel");
    const channelId =
      mention?.channel?.channelId ?? slack.newChannelId(channelType);
    const threadTs = slack.nextTs();
    // The person who posted first in the thread reads the results.
    const historyRoot = Array.isArray(history)
      ? history.find(
          (item): item is MentionInput | ThreadMessageInput =>
            item.kind === "mention" || item.kind === "thread_message",
        )
      : undefined;
    const root = historyRoot ?? first;
    const rootAuthor = slack.registerAuthor(
      root.author ?? DEFAULT_SLACK_AUTHOR,
    );
    return newRecord(
      {
        channelId,
        channelType,
        conversationId: `slack:${channelId}:${threadTs}`,
        surface: "slack",
        threadTs,
      },
      slackAuthorEmail(rootAuthor),
    );
  };

  const newRecord = (
    loaded: (LoadedConversation | AutomationConversation) & {
      idempotencyKey?: string;
    },
    viewerEmail = WEB_VIEWER_EMAIL,
  ): ConversationRecord => {
    knownConversationIds.add(loaded.conversationId);
    return {
      ...loaded,
      idempotencyKey: loaded.idempotencyKey ?? randomUUID(),
      lastSeq: BEFORE_FIRST_EVENT,
      started: false,
      viewerEmail,
      visibleMessages: [],
    };
  };

  /**
   * Send the inputs of one call and wait until the agent is idle. A target
   * function finds a Conversation that the call started, such as the one a
   * due automation started.
   */
  const call = async (
    target: ConversationRecord | (() => ConversationRecord),
    send: () => Promise<void>,
    options: CallOptions,
  ): Promise<Conversation> => {
    const slackCallIndex = readCapturedSlackApiCalls().length;
    const slackPostIndex = slack.posts().length;
    let sentInputs = 0;
    const progressActions = {
      send: async (input: Input) => {
        if (typeof target === "function") {
          throw new Error(
            "send() needs a Conversation from slackMention() or webMessage()",
          );
        }
        await sendInput(target, input);
        sentInputs += 1;
      },
    };
    if (options.onProgress) {
      const onProgress = options.onProgress;
      gateway.setProgressHook(async (progress) => {
        const before = sentInputs;
        await onProgress(progress, progressActions);
        if (sentInputs > before) {
          await new Promise((resolve) => setTimeout(resolve, INPUT_SETTLE_MS));
        }
      });
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
      // Record the run, so the eval report counts the test as a failed eval.
      // Without a run, the report gate fails hard, as for a broken setup.
      context.task.meta.harness = {
        name: "junior",
        run: {
          ...combinedRun(calls, currentUsage(), startedAtMs),
          errors: [serializeError(error)],
        },
      };
      throw error;
    } finally {
      gateway.setProgressHook(undefined);
      slack.setReplyHook(undefined);
    }
    const record = typeof target === "function" ? target() : target;
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
    // such as the opt-out acknowledgement. An automation posts to its
    // destination, and it is the only work of its call.
    const callPosts = slack.posts().slice(slackPostIndex);
    const { replies, visibleMessages } =
      record.surface === "web"
        ? { replies: events.replies, visibleMessages: events.visibleMessages }
        : slackCallReplies({
            durable: events,
            posts:
              record.surface === "automation"
                ? callPosts
                : callPosts.filter(
                    (post) =>
                      post.channel === record.channelId &&
                      post.threadTs === record.threadTs,
                  ),
            conversationId: record.conversationId,
          });
    record.visibleMessages.push(...visibleMessages);
    const thread = record.surface === "slack" ? record : undefined;
    const slackCalls = thread
      ? readCapturedSlackApiCalls().slice(slackCallIndex)
      : [];
    // Slack reactions are sets; ingress and the worker can add the same one.
    const reactions = [
      ...new Set(
        slackCalls.flatMap((captured) =>
          captured.method === "reactions.add" &&
          captured.params.channel === thread?.channelId &&
          typeof captured.params.name === "string"
            ? [`${String(captured.params.timestamp)}:${captured.params.name}`]
            : [],
        ),
      ),
    ].map((key) => key.slice(key.indexOf(":") + 1));
    const files = slackCalls.flatMap((captured) =>
      captured.method === "files.completeUploadExternal" &&
      captured.params.channel_id === thread?.channelId &&
      captured.params.thread_ts === thread?.threadTs &&
      Array.isArray(captured.params.files)
        ? captured.params.files.map((file: { title?: unknown }) =>
            String(file.title),
          )
        : [],
    );
    const threadCalls = (method: string) =>
      slackCalls.filter(
        (captured) =>
          captured.method === method &&
          captured.params.channel_id === thread?.channelId &&
          captured.params.thread_ts === thread?.threadTs,
      );
    const statuses = threadCalls("assistant.threads.setStatus").map(
      (captured) => String(captured.params.status),
    );
    const threadTitles = threadCalls("assistant.threads.setTitle").map(
      (captured) => String(captured.params.title),
    );
    const authorizationPrompt = await readAuthorizationPrompt(
      api,
      record.conversationId,
      record.viewerEmail,
    );
    agentCostUsd.set(
      record.conversationId,
      (detail.modelUsage ?? []).reduce(
        (sum, entry) => sum + (entry.usage.cost?.total ?? 0),
        0,
      ),
    );
    const usage = currentUsage();
    const callRun = toHarnessRun({
      conversationId: record.conversationId,
      earlier,
      usage,
      messages: visibleMessages,
      startedAtMs,
      toolCalls: events.toolCalls,
    });
    calls.push({
      conversationId: record.conversationId,
      events: callRun.session.events,
    });
    context.task.meta.harness = {
      name: "junior",
      run: combinedRun(calls, usage, startedAtMs),
    };
    return conversationResult(record, {
      ...callRun,
      ...(authorizationPrompt
        ? { authorizationPrompt: authorizationPrompt.label }
        : undefined),
      compactions: events.compactions,
      files,
      reactions,
      replies,
      statuses,
      threadTitles,
      title: detail.displayTitle,
      toolCalls: events.toolCalls,
      turns: events.turns,
    });
  };

  /** Load history, then send the inputs as one call. */
  const converse = async (
    record: ConversationRecord,
    input: Input | Input[],
    options: CallOptions,
  ): Promise<Conversation> => {
    if (hasHistory(options.history)) {
      if (record.surface === "automation") {
        throw new Error("A Conversation from an automation takes no history");
      }
      record.lastSeq = await loadHistory({
        api,
        conversation: record,
        items: options.history,
        replyMessages,
        slack,
        viewerEmail: record.viewerEmail,
      });
      record.started = true;
    }
    const inputs = Array.isArray(input) ? input : [input];
    return await call(
      record,
      async () => {
        // Inputs in one call arrive before the worker runs, as one batch.
        if (inputs.length > 1) queue.hold();
        try {
          for (const next of inputs) await sendInput(record, next);
        } finally {
          queue.release();
        }
      },
      options,
    );
  };

  const fork = async (
    record: ConversationRecord,
    forkReply: Reply | HistoryReply,
  ): Promise<Conversation> => {
    const messageId =
      "messageId" in forkReply
        ? forkReply.messageId
        : replyMessages.get(forkReply);
    if (!messageId) {
      throw new Error("fork() needs a reply from this test");
    }
    const response = await api.request(
      `/api/conversations/${encodeURIComponent(record.conversationId)}/forks`,
      jsonRequest(record.viewerEmail, {
        idempotencyKey: fixtureId("fork", 32),
        messageId,
      }),
    );
    if (response.status !== 200) {
      throw new Error(
        `Fork returned ${response.status}: ${await response.text()}`,
      );
    }
    const forked = forkConversationResponseSchema.parse(await response.json());
    // The person who forked owns the fork.
    const forkRecord = newRecord(
      { conversationId: forked.conversationId, surface: "web" },
      record.viewerEmail,
    );
    forkRecord.started = true;
    const detail = await readConversationDetail(
      api,
      forkRecord.conversationId,
      forkRecord.viewerEmail,
    );
    const copied = readCallEvents({
      afterSeq: BEFORE_FIRST_EVENT,
      conversationId: forkRecord.conversationId,
      detail,
    });
    forkRecord.lastSeq = copied.lastSeq;
    forkRecord.visibleMessages = copied.visibleMessages;
    return conversationResult(forkRecord, {
      ...toHarnessRun({
        conversationId: forkRecord.conversationId,
        earlier: forkRecord.visibleMessages,
        usage: currentUsage(),
        messages: [],
        startedAtMs,
        toolCalls: [],
      }),
      compactions: 0,
      files: [],
      reactions: [],
      replies: [],
      statuses: [],
      threadTitles: [],
      title: detail.displayTitle,
      toolCalls: [],
      turns: [],
    });
  };

  const conversationResult = (
    record: ConversationRecord,
    result: Omit<Conversation, "continue" | "conversationId" | "fork">,
  ): Conversation => ({
    conversationId: record.conversationId,
    ...result,
    continue: (input, options = {}) =>
      runEvalWork(() => converse(record, input, options)),
    fork: (reply) => runEvalWork(() => fork(record, reply)),
  });

  /** Send an automation input and return the Conversation it started. */
  const runAutomation = async (
    input: AutomationInput,
    options: CallOptions,
  ): Promise<Conversation> => {
    const sentIndex = queue.sentConversationIds().length;
    return await call(
      () => {
        const startedIds = [
          ...new Set(queue.sentConversationIds().slice(sentIndex)),
        ].filter((id) => !knownConversationIds.has(id));
        if (startedIds.length !== 1) {
          throw new Error(
            `${input.kind} started ${startedIds.length} Conversations; expected 1`,
          );
        }
        const record = newRecord(
          { conversationId: startedIds[0]!, surface: "automation" },
          slackAuthorEmail(DEFAULT_SLACK_AUTHOR),
        );
        record.started = true;
        return record;
      },
      async () => await postAutomationInput(input),
      options,
    );
  };

  const run: RunAgent = async (input, options = {}) => {
    const inputs = Array.isArray(input) ? input : [input];
    const [first] = inputs;
    if (!first) throw new Error("run() needs an input");
    if (isAutomationInput(first)) {
      if (inputs.length > 1 || hasHistory(options.history)) {
        throw new Error(`run(${first.kind}) takes no other input or history`);
      }
      return await runAutomation(first, options);
    }
    if (first.kind === "complete_auth") {
      throw new Error("completeAuth() continues a Conversation");
    }
    if (first.kind === "slack_command") {
      throw new Error("slackCommand() continues a Slack Conversation");
    }
    return await converse(
      newConversation(first, options.history),
      input,
      options,
    );
  };

  return { run, close };
}

function isAutomationInput(input: Input): input is AutomationInput {
  return input.kind === "heartbeat" || input.kind === "github_webhook";
}

/** The production request for an automation input. */
function automationRequest(input: AutomationInput): Request {
  if (input.kind === "heartbeat") {
    return new Request("http://junior.test/api/internal/heartbeat", {
      headers: { authorization: `Bearer ${heartbeatSecret()}` },
    });
  }
  const body = JSON.stringify({
    ...input.payload,
    installation: { id: Number(requiredEnv("GITHUB_INSTALLATION_ID")) },
  });
  const signature = createHmac("sha256", requiredEnv("GITHUB_WEBHOOK_SECRET"))
    .update(body)
    .digest("hex");
  return new Request("http://junior.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": randomUUID(),
      "x-github-event": input.event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`The agent test fixture needs ${name}`);
  return value;
}

/** The secret of the heartbeat route, read as the route reads it. */
function heartbeatSecret(): string {
  const secret =
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim();
  if (!secret) {
    throw new Error("The agent test fixture needs JUNIOR_SCHEDULER_SECRET");
  }
  return secret;
}

/** An image as the dashboard sends it with a message. */
function webImage(image: FileInput) {
  if (!image.content) throw new Error(`Image ${image.name} needs content`);
  return {
    contentType: image.mimeType,
    data: image.content.toString("base64"),
    filename: image.name,
  };
}

/** A JSON POST signed in as `viewerEmail`. */
function jsonRequest(viewerEmail: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [VIEWER_HEADER]: viewerEmail,
    },
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
