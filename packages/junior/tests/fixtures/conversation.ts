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
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
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

/** Default verified web Actor for Conversation tests. */
const WEB_TEST_EMAIL = "alice@example.com";
export const webTestActor = {
  platform: "web" as const,
  userId: webActorFromEmail(WEB_TEST_EMAIL).userId,
  email: WEB_TEST_EMAIL,
  fullName: "Alice Example",
  userName: "alice",
} as const satisfies WebActor;

export type ConversationFixture = {
  actor: typeof webTestActor;
  conversationStore: ConversationStore;
  queue: ConversationWorkQueueTestAdapter;
  state: StateAdapter;
};

/**
 * Wire the standard product store, queue, and state for Conversation tests.
 *
 * Callers should run `closeConversationFixture` from `afterEach`.
 */
export async function createConversationFixture(): Promise<ConversationFixture> {
  const conversationStore = getConversationStore();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  await state.connect();
  return {
    actor: webTestActor,
    conversationStore,
    queue,
    state,
  };
}

/** Release state + SQL handles opened by `createConversationFixture`. */
export async function closeConversationFixture(): Promise<void> {
  await disconnectStateAdapter();
  await closeDb();
}

/** Empty-mailbox worker attempt used by resume-routing cases. */
export function emptyConversationTurnAttempt(args: {
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

export type ConversationWebHarness = {
  actor: typeof webTestActor;
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
  /** Drain the durable queue through the production Conversation route. */
  drain: () => Promise<void>;
  /** Read participant pending-messages, including authorization prompts. */
  pendingMessages: (
    conversationId: string,
  ) => Promise<ConversationPendingMessagesReport>;
  /** Load durable assistant/user history for one conversation. */
  historyTexts: (conversationId: string) => Promise<string[]>;
};

/**
 * Build the production Conversation route, queue, and agent path.
 * Fake only model generation at the agent Run boundary.
 */
export async function createConversationWebHarness(
  streamFn: StreamFn = streamReplies("Conversation request complete."),
): Promise<ConversationWebHarness> {
  const conversationStore = getConversationStore();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  await state.connect();
  let modelStream = streamFn;
  const agentRuns: AgentRun[] = [];
  const agentRunner: AgentRunner = {
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
  const actor = webTestActor;
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
      const accepted = await createAndEnqueueConversation(
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
      const accepted = await appendAndEnqueueWebMessage(
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
