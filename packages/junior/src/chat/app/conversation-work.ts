import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { VercelConversationWorkCallbackOptions } from "@/chat/task-execution/vercel-callback";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { runNextPausedTurn } from "@/chat/task-execution/paused-turn";
import { createPausedTurns } from "@/chat/task-execution/turn-wake";
import {
  buildDispatchRoutingContext,
  createAgentDispatchConversationWorker,
  createAgentDispatchWorkRouter,
} from "@/chat/agent-dispatch/work";
import {
  createAgentInvocationWorker,
  routeAgentInvocationWork,
} from "@/chat/agent-invocations/work";
import {
  createMailboxTurnWorker,
  routeMailboxTurnWork,
} from "@/chat/api-turns/work";
import {
  createApiTurnCancellation,
  type ApiTurnCancellation,
} from "@/chat/api-turns/cancellation";
import {
  getDispatchConversationId,
  getDispatchInputMessageId,
} from "@/chat/agent-dispatch/store";
import { createSlackRuntime } from "./factory";
import type { JuniorRuntimeServiceOverrides } from "./services";
import { createSlackSystemTurnPublisher } from "@/chat/providers/slack/system-turn";

interface ConversationWorkOptions {
  agentRunner: AgentRunner;
  conversationStore: ConversationStore;
  getSlackAdapter: () => SlackAdapter;
  queue: ConversationWorkQueue;
  services?: JuniorRuntimeServiceOverrides;
  state?: StateAdapter;
}

export type ConversationWorkCallbackOptions =
  VercelConversationWorkCallbackOptions & {
    /** App-scoped Turn cancellation for Conversation API request handlers. */
    apiTurnCancellation?: ApiTurnCancellation;
  };

/**
 * Compose conversation work once for production and integration tests.
 * Environment-specific queue, state, Slack, and agent adapters stop here.
 */
export function createConversationWork(
  options: ConversationWorkOptions,
): ConversationWorkCallbackOptions & {
  runtime: ReturnType<typeof createSlackRuntime>;
} {
  const apiTurnCancellation = createApiTurnCancellation();
  const pausedTurns = createPausedTurns({
    conversationStore: options.conversationStore,
    queue: options.queue,
    ...(options.state ? { state: options.state } : undefined),
  });
  const runtime = createSlackRuntime({
    getSlackAdapter: options.getSlackAdapter,
    pausedTurns,
    services: {
      ...options.services,
      agentRunner: options.agentRunner,
    },
  });
  const slackWorker = createSlackConversationWorker({
    getSlackAdapter: options.getSlackAdapter,
    runNextPausedTurn: async (conversationId, runOptions) =>
      await runNextPausedTurn(
        conversationId,
        {
          agentRunner: options.agentRunner,
          wakePausedTurn: pausedTurns.wake,
        },
        runOptions,
      ),
    runtime,
    state: options.state,
  });
  const dispatchWorker = createAgentDispatchConversationWorker({
    resumeTurn: async (dispatch, hooks) => {
      await runNextPausedTurn(
        getDispatchConversationId(dispatch),
        {
          agentRunner: options.agentRunner,
          inputMessageIds: [getDispatchInputMessageId(dispatch.id)],
          routingContext: buildDispatchRoutingContext(dispatch),
          wakePausedTurn: pausedTurns.wake,
        },
        { shouldYield: hooks.shouldYield },
      );
    },
    runTurn: runtime.runDispatchTurn,
  });
  // Destination chooses the provider worker. Do not fall through to Slack when
  // destination is missing or not Slack.
  const destinationWorker = async (
    context: Parameters<typeof slackWorker>[0],
  ) => {
    const destination = context.destination;
    if (!destination) {
      throw new Error(
        `Conversation ${context.conversationId} is missing a destination`,
      );
    }
    if (destination.platform === "slack") {
      return await slackWorker(context);
    }
    // Local resource-event and dashboard wakes are claimed earlier by
    // routeMailboxTurnWork. A local Destination here has no matching work.
    throw new Error(
      `Conversation ${context.conversationId} has a ${destination.platform} destination but no matching conversation worker`,
    );
  };
  const providerWorker = createAgentDispatchWorkRouter({
    dispatchWorker,
    fallbackWorker: destinationWorker,
  });
  return {
    apiTurnCancellation,
    conversationStore: options.conversationStore,
    queue: options.queue,
    run: routeMailboxTurnWork({
      mailboxTurnWorker: createMailboxTurnWorker(
        options.agentRunner,
        apiTurnCancellation,
        createSlackSystemTurnPublisher({
          getSlackAdapter: options.getSlackAdapter,
          state: options.state,
        }),
      ),
      fallbackWorker: routeAgentInvocationWork({
        invocationWorker: createAgentInvocationWorker(options.agentRunner),
        fallbackWorker: providerWorker,
      }),
    }),
    runtime,
    state: options.state,
  };
}
