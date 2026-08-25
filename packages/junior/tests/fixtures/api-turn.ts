import type { StateAdapter } from "chat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Destination } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  conversationPendingMessagesReportSchema,
  type ConversationPendingMessagesReport,
} from "@/api/schema";
import type { WebActor } from "@/chat/actor";
import { executeAgentRun } from "@/chat/agent";
import {
  appendAndEnqueueApiConversationMessage,
  createAndEnqueueApiConversation,
  webActorFromEmail,
} from "@/chat/api-turns/work";
import {
  createConversationWork,
  type ConversationWorkCallbackOptions,
} from "@/chat/app/conversation-work";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRun } from "@/chat/agent/types";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import {
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  streamReplies,
  type ConversationWorkQueueTestAdapter,
} from "./conversation-work";
import { testViewer } from "./user";

/** Default verified dashboard viewer for web turn tests. */
const API_TURN_TEST_EMAIL = "alice@example.com";
export const apiTurnTestActor = {
  platform: "web" as const,
  userId: webActorFromEmail(API_TURN_TEST_EMAIL).userId,
  email: API_TURN_TEST_EMAIL,
  fullName: "Alice Example",
  userName: "alice",
} as const satisfies WebActor;

export type ApiTurnWorkFixture = {
  actor: typeof apiTurnTestActor;
  conversationStore: ConversationStore;
  queue: ConversationWorkQueueTestAdapter;
  state: StateAdapter;
};

/**
 * Wire the standard product store + queue + state path for web turn tests.
 *
 * Callers should run `closeApiTurnWorkFixture` from `afterEach`.
 */
export async function createApiTurnWorkFixture(): Promise<ApiTurnWorkFixture> {
  const conversationStore = getConversationStore();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  await state.connect();
  return {
    actor: apiTurnTestActor,
    conversationStore,
    queue,
    state,
  };
}

/** Release state + SQL handles opened by `createApiTurnWorkFixture`. */
export async function closeApiTurnWorkFixture(): Promise<void> {
  await disconnectStateAdapter();
  await closeDb();
}

/** Empty-mailbox worker attempt used by resume-routing cases. */
export function emptyApiTurnAttempt(args: {
  conversationId: string;
  destination: Destination;
}): ConversationWorkerContext["attempt"] {
  return {
    ack: async () => undefined,
    conversationId: args.conversationId,
    destination: args.destination,
    drain: async () => [],
    isFinalAttempt: false,
    messages: [],
  };
}

export type ConversationWorkWebHarness = {
  actor: typeof apiTurnTestActor;
  agentRuns: AgentRun[];
  agentRunner: AgentRunner;
  conversationWork: ConversationWorkCallbackOptions;
  conversationStore: ConversationStore;
  queue: ConversationWorkQueueTestAdapter;
  state: StateAdapter;
  setModelStream: (next: StreamFn) => void;
  /** Create a new web root conversation and enqueue the first message. */
  start: (args: {
    idempotencyKey: string;
    message: string;
  }) => Promise<{ conversationId: string; messageId: string }>;
  /** Append one web follow-up to an existing conversation. */
  continue: (args: {
    conversationId: string;
    idempotencyKey: string;
    message: string;
  }) => Promise<{ messageId: string }>;
  /** Drain the durable queue through the production web/API turn router. */
  drain: () => Promise<void>;
  /** Read participant pending-messages, including authorization prompts. */
  pendingMessages: (
    conversationId: string,
  ) => Promise<ConversationPendingMessagesReport>;
  /** Load durable assistant/user history for one conversation. */
  historyTexts: (conversationId: string) => Promise<string[]>;
};

/**
 * Compose the production web ingress → durable queue → API turn → agent path.
 * Fake only model generation at the executeAgentRun stream boundary.
 */
export async function createConversationWorkWebHarness(
  options: {
    agentRunner?: AgentRunner;
    modelStream?: StreamFn;
  } = {},
): Promise<ConversationWorkWebHarness> {
  const conversationStore = getConversationStore();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  await state.connect();
  let modelStream = options.modelStream ?? streamReplies("Web turn complete.");
  const agentRuns: AgentRun[] = [];
  const agentRunner: AgentRunner = options.agentRunner ?? {
    run: async (request) => {
      agentRuns.push(request);
      return await executeAgentRun(request, modelStream);
    },
  };
  const work = createConversationWork({
    agentRunner,
    conversationStore,
    getSlackAdapter: () => createSlackAdapterFixture(),
    queue,
    state,
  });
  const actor = apiTurnTestActor;
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(actor.email));
    await next();
  });
  app.route("/", createJuniorApi());

  return {
    actor,
    agentRuns,
    agentRunner,
    conversationWork: {
      apiTurnCancellation: work.apiTurnCancellation,
      conversationStore,
      queue,
      run: work.run,
      state,
    },
    conversationStore,
    queue,
    state,
    setModelStream(next: StreamFn) {
      modelStream = next;
    },
    start: async ({ idempotencyKey, message }) => {
      const accepted = await createAndEnqueueApiConversation(
        {
          actor,
          idempotencyKey,
          message,
        },
        { conversationStore, queue, state },
      );
      return {
        conversationId: accepted.conversationId,
        messageId: accepted.messageId,
      };
    },
    continue: async ({ conversationId, idempotencyKey, message }) => {
      const accepted = await appendAndEnqueueApiConversationMessage(
        {
          actor,
          conversationId,
          idempotencyKey,
          message,
        },
        { conversationStore, queue, state },
      );
      return { messageId: accepted.messageId };
    },
    drain: async () => {
      for (let i = 0; i < 12 && queue.hasQueuedMessages(); i += 1) {
        await processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: work.run,
          state,
        });
      }
      if (queue.hasQueuedMessages()) {
        throw new Error("queue still has work after drain");
      }
    },
    pendingMessages: async (conversationId) => {
      const response = await app.request(
        `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/pending-messages`,
      );
      if (response.status !== 200) {
        throw new Error(
          `pending-messages failed: ${response.status} ${await response.text()}`,
        );
      }
      return conversationPendingMessagesReportSchema.parse(
        await response.json(),
      );
    },
    historyTexts: async (conversationId) => {
      const history =
        await getConversationEventStore().loadMessageHistory(conversationId);
      return history.events
        .filter((event) => event.data.type === "message")
        .map((event) => {
          const data = event.data as { text?: string };
          return typeof data.text === "string" ? data.text : "";
        })
        .filter(Boolean);
    },
  };
}
