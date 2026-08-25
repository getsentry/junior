import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { VercelConversationWorkCallbackOptions } from "@/chat/task-execution/vercel-callback";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { runNextPausedTurn } from "@/chat/task-execution/paused-turn";
import {
  getPausedTurnRequest,
  wakePausedTurn,
} from "@/chat/task-execution/turn-wake";
import {
  buildDispatchRoutingContext,
  createAgentDispatchConversationWorker,
  createAgentDispatchWorkRouter,
} from "@/chat/agent-dispatch/work";
import {
  createAgentInvocationWorker,
  routeAgentInvocationWork,
} from "@/chat/agent-invocations/work";
import { createApiTurnWorker, routeApiTurnWork } from "@/chat/api-turns/work";
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
  const services: JuniorRuntimeServiceOverrides = {
    ...options.services,
    replyExecutor: {
      ...options.services?.replyExecutor,
      agentRunner: options.agentRunner,
      getPausedTurnRequest:
        options.services?.replyExecutor?.getPausedTurnRequest ??
        (async (request) =>
          await getPausedTurnRequest({
            ...request,
            conversationStore: options.conversationStore,
          })),
      wakePausedTurn:
        options.services?.replyExecutor?.wakePausedTurn ??
        (async (request) =>
          await wakePausedTurn(request, {
            queue: options.queue,
            state: options.state,
          })),
    },
  };
  const runtime = createSlackRuntime({
    getSlackAdapter: options.getSlackAdapter,
    services,
  });
  const slackWorker = createSlackConversationWorker({
    getSlackAdapter: options.getSlackAdapter,
    conversationStore: options.conversationStore,
    runNextPausedTurn: async (conversationId, runOptions) =>
      await runNextPausedTurn(
        conversationId,
        {
          agentRunner: options.agentRunner,
          wakePausedTurn: services.replyExecutor?.wakePausedTurn,
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
          wakePausedTurn: services.replyExecutor?.wakePausedTurn,
        },
        { shouldYield: hooks.shouldYield },
      );
    },
    runTurn: runtime.runDispatchTurn,
  });
  const providerWorker = createAgentDispatchWorkRouter({
    dispatchWorker,
    fallbackWorker: slackWorker,
  });
  return {
    apiTurnCancellation,
    conversationStore: options.conversationStore,
    queue: options.queue,
    run: routeApiTurnWork({
      apiTurnWorker: createApiTurnWorker(
        options.agentRunner,
        apiTurnCancellation,
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
