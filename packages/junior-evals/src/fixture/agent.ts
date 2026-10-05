/**
 * One Junior app for one test, driven only through its routes.
 *
 * The agent, the model, Guardian, the turn router, titles, the reply policy,
 * compaction, Postgres, and Redis are real. Slack, Vercel Blob, and other
 * third-party APIs are MSW mocks. The fixture replaces the Vercel Queue
 * transports and `waitUntil` with in-process versions, so it knows when the
 * agent and its plugin tasks are idle.
 */
import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { assert } from "vitest";
import type { HarnessRun, TranscriptEvent } from "vitest-evals/harness";
import { createApp, type JuniorAppOptions } from "@/app";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { acceptedConversationMessageSchema } from "@/api/schema";
import { forkConversationResponseSchema } from "@/api/schema";
import { createConversationId } from "@/chat/conversations/web-input";
import { registerLogRecordSink } from "@/chat/logging";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { readCapturedSlackApiCalls } from "@junior-tests/msw/captured-slack-api-calls";
import { runEvalWork } from "../eval-work";
import { installBlobMock } from "./blob";
import {
  installGatewayObserver,
  type GatewayModelCall,
  type GatewayProgress,
} from "./gateway";
import type {
  AutomationInput,
  HistoryItem,
  HistoryReply,
  Input,
  MessageInput,
} from "./inputs";
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
  combinedRun,
  readAuxiliaryOperations,
  readCallEvents,
  readConversationDetail,
  readDistillationDecision,
  readDistillationUsage,
  readModelCalls,
  readModelTotals,
  slackCallReplies,
  toHarnessRun,
  VIEWER_HEADER,
  type FixtureUsage,
  type AuxiliaryOperationUsage,
  type DistillationUsage,
  type DistillationDecision,
  type ModelCallUsage,
  type ModelTotalUsage,
  type Reply,
  type ToolCall,
  type Turn,
} from "./results";
import {
  DEFAULT_SLACK_AUTHOR,
  installSlackMock,
  isAppMention,
  postSlackMessageEvent,
  slackAuthorEmail,
  SLACK_BOT_USER_ID,
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
  /** Names of the files that Junior uploaded to the Slack thread. */
  files: string[];
  /** The title that the dashboard shows after the call. */
  title: string;
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
  const slack = installSlackMock();
  const gateway = installGatewayObserver();
  const blob = await installBlobMock();
  const app = await createApp({
    ...options,
    conversationWorkQueue: (consume) => queue.connect(consume),
    // Plugin tasks run in process. A call is idle only after they finish.
    pluginTaskQueue: (consume) => ({
      send: async (message) => track(consume(message)),
    }),
    waitUntil: (task) => track(typeof task === "function" ? task() : task),
  });
  const knownConversationIds = new Set<string>();
  const distillationDecisions = new Map<string, DistillationDecision[]>();
  const unregisterLogSink = registerLogRecordSink((record) => {
    const decision = readDistillationDecision(record);
    if (!decision || !knownConversationIds.has(decision.conversationId)) return;
    const current = distillationDecisions.get(decision.conversationId) ?? [];
    current.push(decision);
    distillationDecisions.set(decision.conversationId, current);
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
      unregisterLogSink();
      await blob.close();
    }
  };

  const replyMessages = new WeakMap<HistoryReply, string>();
  const calls: Array<{ conversationId: string; events: TranscriptEvent[] }> =
    [];
  // Agent model cost per Conversation, from the reporting API.
  const agentCostUsd = new Map<string, number>();
  const auxiliaryCostUsd = new Map<string, number>();
  const auxiliaryOperations = new Map<string, AuxiliaryOperationUsage[]>();
  const distillation = new Map<string, DistillationUsage>();
  const agentModelCalls = new Map<string, ModelCallUsage[]>();
  const agentModelTotals = new Map<string, ModelTotalUsage[]>();
  const gatewayModelCalls: GatewayModelCall[] = [];
  const currentUsage = (): FixtureUsage => ({
    agentCostUsd: [...agentCostUsd.values()].reduce((a, b) => a + b, 0),
    auxiliaryCostUsd: [...auxiliaryCostUsd.values()].reduce((a, b) => a + b, 0),
    auxiliaryOperations: [...auxiliaryOperations.values()].flat(),
    distillation: Object.fromEntries(distillation),
    distillationDecisions: Object.fromEntries(distillationDecisions),
    gatewayRequests: gateway.requestCounts(),
    gatewayModelCalls: [...gatewayModelCalls],
    modelCalls: [...agentModelCalls.values()].flat(),
    modelTotals: [...agentModelTotals.values()].flat(),
  });
  const startedAtMs = Date.now();
  // Every judged call of the test, for the eval report.
  const judgeScores: Array<{
    metadata: Record<string, string>;
    name: string;
    score: number;
  }> = [];

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
            idempotencyKey: started ? randomUUID() : record.idempotencyKey,
            message: input.text,
          }),
        ),
      );
      return;
    }
    if (record.surface !== "slack") {
      throw new Error("Slack input needs a Slack Conversation");
    }
    if (!started && input.kind !== "mention") {
      throw new Error("A Slack Conversation starts with mention()");
    }
    const author = slack.registerAuthor(input.author ?? DEFAULT_SLACK_AUTHOR);
    const ts = started ? slack.nextTs() : record.threadTs;
    const mention = isAppMention(input, record.channelType);
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
      ...(started ? { threadTs: record.threadTs } : undefined),
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
      const idempotencyKey = randomUUID();
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
      throw new Error("run() needs mention() or webMessage() first");
    }
    const channelType =
      (first.kind === "mention" && first.channelType) || "channel";
    const channelId =
      (first.kind === "mention" ? first.channel?.channelId : undefined) ??
      slack.newChannelId(channelType);
    const threadTs = slack.nextTs();
    // The person who posted the thread root reads the results.
    const historyRoot = Array.isArray(history) ? history[0] : undefined;
    const root =
      historyRoot &&
      historyRoot.kind !== "reply" &&
      historyRoot.kind !== "web_message"
        ? historyRoot
        : first;
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
    const progressActions = {
      send: async (input: Input) => {
        if (typeof target === "function") {
          throw new Error(
            "send() needs a Conversation from mention() or webMessage()",
          );
        }
        await sendInput(target, input);
      },
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
    gateway.setRecording(true);
    try {
      await send();
      await waitForIdle();
    } catch (error) {
      // Work must not outlive the test and reach closed stores.
      await close();
      throw error;
    } finally {
      gateway.setRecording(false);
      gateway.setProgressHook(undefined);
      slack.setReplyHook(undefined);
    }
    gatewayModelCalls.push(
      ...(await gateway.modelCalls()).slice(gatewayModelCalls.length),
    );
    const record = typeof target === "function" ? target() : target;
    const detail = await readConversationDetail(
      api,
      record.conversationId,
      record.viewerEmail,
    );
    const afterSeq = record.lastSeq;
    const events = readCallEvents({
      afterSeq,
      conversationId: record.conversationId,
      detail,
    });
    const earlier = [...record.visibleMessages];
    record.lastSeq = events.lastSeq;
    agentModelCalls.set(record.conversationId, [
      ...(agentModelCalls.get(record.conversationId) ?? []),
      ...readModelCalls(detail.events, afterSeq),
    ]);
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
    agentCostUsd.set(
      record.conversationId,
      (detail.modelUsage ?? []).reduce(
        (sum, entry) => sum + (entry.usage.cost?.total ?? 0),
        0,
      ),
    );
    auxiliaryCostUsd.set(
      record.conversationId,
      detail.auxiliaryCosts?.costUsd ?? 0,
    );
    auxiliaryOperations.set(
      record.conversationId,
      readAuxiliaryOperations(detail),
    );
    distillation.set(record.conversationId, readDistillationUsage(detail));
    agentModelTotals.set(
      record.conversationId,
      readModelTotals(detail.modelUsage ?? []),
    );
    const usage = currentUsage();
    const evalRun = toHarnessRun({
      conversationId: record.conversationId,
      usage,
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
      run: combinedRun(calls, usage, startedAtMs),
    };
    if (options.criteria) {
      const judged = await judgeReplies({
        criteria: options.criteria,
        current: visibleMessages,
        earlier,
        signal: context.signal,
      });
      judgeScores.push({
        name: "RubricJudge",
        score: judged.score,
        metadata: { answer: judged.answer, rationale: judged.rationale },
      });
      context.task.meta.eval = {
        avgScore:
          judgeScores.reduce((sum, entry) => sum + entry.score, 0) /
          judgeScores.length,
        scores: judgeScores,
        thresholdFailed: judgeScores.some(
          (entry) => entry.score < JUDGE_THRESHOLD,
        ),
      };
      assert(
        judged.score >= JUDGE_THRESHOLD,
        `Rubric score ${judged.score} is below ${JUDGE_THRESHOLD}: ${judged.rationale}`,
      );
    }
    return conversationResult(record, {
      evalRun,
      files,
      reactions,
      replies,
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
        idempotencyKey: randomUUID(),
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
      evalRun: toHarnessRun({
        conversationId: forkRecord.conversationId,
        usage: currentUsage(),
        messages: [],
        startedAtMs,
        toolCalls: [],
      }),
      files: [],
      reactions: [],
      replies: [],
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
