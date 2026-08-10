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
import {
  getDispatchConversationId,
  getDispatchInputMessageIds,
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

/**
 * Compose conversation work once for production and integration tests.
 * Environment-specific queue, state, Slack, and agent adapters stop here.
 */
export function createConversationWork(
  options: ConversationWorkOptions,
): VercelConversationWorkCallbackOptions & {
  runtime: ReturnType<typeof createSlackRuntime>;
} {
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
          scheduleSessionCompletedPluginTasks:
            services.replyExecutor?.scheduleSessionCompletedPluginTasks,
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
          inputMessageIds: getDispatchInputMessageIds(dispatch.id),
          routingContext: buildDispatchRoutingContext(dispatch),
          scheduleSessionCompletedPluginTasks:
            services.replyExecutor?.scheduleSessionCompletedPluginTasks,
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
    conversationStore: options.conversationStore,
    queue: options.queue,
    run: routeAgentInvocationWork({
      invocationWorker: createAgentInvocationWorker({
        agentRunner: options.agentRunner,
      }),
      fallbackWorker: providerWorker,
    }),
    runtime,
    state: options.state,
  };
}
