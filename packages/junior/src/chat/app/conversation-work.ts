import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import type { VercelConversationWorkCallbackOptions } from "@/chat/task-execution/vercel-callback";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { runNextPausedTurn } from "@/chat/task-execution/paused-turn";
import { createPausedTurns } from "@/chat/task-execution/turn-wake";
import {
  buildDispatchRoutingContext,
  createAgentDispatchConversationWorker,
  resolveAgentDispatchId,
} from "@/chat/agent-dispatch/work";
import {
  createAgentInvocationWorker,
  resolveAgentInvocationId,
} from "@/chat/agent-invocations/work";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import {
  getDispatchConversationId,
  getDispatchInputMessageId,
} from "@/chat/agent-dispatch/store";
import { createSlackRuntime } from "./factory";
import type { JuniorRuntimeServiceOverrides } from "./services";
import { createSlackSystemTurnDelivery } from "@/chat/providers/slack/system-turn";
import {
  scheduleSessionCompletedPluginTasks,
  type ScheduleSessionCompletedPluginTasksOptions,
} from "@/chat/plugins/task-runner";

type SlackRuntime = ReturnType<typeof createSlackRuntime>;

interface ConversationWorkOptions {
  agentRunner: AgentRunner;
  conversationStore: ConversationStore;
  getSlackAdapter: () => SlackAdapter;
  queue: ConversationWorkQueue;
  /**
   * Optional plugin-task send path for completed Turns.
   * Production omits this and uses the default Vercel queue sender.
   */
  sendPluginTask?: ScheduleSessionCompletedPluginTasksOptions["send"];
  services?: JuniorRuntimeServiceOverrides;
  state?: StateAdapter;
  /**
   * Optional wrapper around the composed Slack runtime.
   * Eval harnesses use this so worker Delivery lands on TestThreads.
   */
  wrapRuntime?: (runtime: SlackRuntime) => SlackRuntime;
}

export type ConversationWorkCallbackOptions =
  VercelConversationWorkCallbackOptions;

/**
 * Build conversation work once for production and integration tests.
 * The app chooses the queue, state, Slack, and agent values here.
 */
export function createConversationWork(
  options: ConversationWorkOptions,
): ConversationWorkCallbackOptions & {
  runtime: SlackRuntime;
} {
  const pausedTurns = createPausedTurns({
    conversationStore: options.conversationStore,
    queue: options.queue,
    ...(options.state ? { state: options.state } : undefined),
  });
  const baseRuntime = createSlackRuntime({
    getSlackAdapter: options.getSlackAdapter,
    pausedTurns,
    ...(options.sendPluginTask
      ? { sendPluginTask: options.sendPluginTask }
      : undefined),
    services: {
      ...options.services,
      agentRunner: options.agentRunner,
    },
  });
  const runtime = options.wrapRuntime?.(baseRuntime) ?? baseRuntime;
  const scheduleCompletedPluginTasks = options.sendPluginTask
    ? async (params: Parameters<typeof scheduleSessionCompletedPluginTasks>[0]) =>
        await scheduleSessionCompletedPluginTasks(params, {
          send: options.sendPluginTask,
        })
    : undefined;
  const slackWorker = createSlackConversationWorker({
    getSlackAdapter: options.getSlackAdapter,
    runNextPausedTurn: async (conversationId, runOptions) =>
      await runNextPausedTurn(
        conversationId,
        {
          agentRunner: options.agentRunner,
          wakePausedTurn: pausedTurns.wake,
          ...(scheduleCompletedPluginTasks
            ? {
                scheduleSessionCompletedPluginTasks:
                  scheduleCompletedPluginTasks,
              }
            : undefined),
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
          ...(scheduleCompletedPluginTasks
            ? {
                scheduleSessionCompletedPluginTasks:
                  scheduleCompletedPluginTasks,
              }
            : undefined),
        },
        { shouldYield: hooks.shouldYield },
      );
    },
    runTurn: runtime.runDispatchTurn,
  });
  const invocationWorker = createAgentInvocationWorker(options.agentRunner);
  const conversationTurnWorker = createConversationTurnWorker(
    options.agentRunner,
    createSlackSystemTurnDelivery({
      getSlackAdapter: options.getSlackAdapter,
      state: options.state,
    }),
  );
  // A Slack Destination uses the Slack worker. All other work must have been
  // selected above this function.
  const destinationWorker = async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const destination = context.destination;
    if (!destination) {
      throw new Error(
        `Conversation ${context.conversationId} is missing a destination`,
      );
    }
    if (destination.platform === "slack") {
      return await slackWorker(context);
    }
    throw new Error(
      `Conversation ${context.conversationId} has a ${destination.platform} destination but no matching conversation worker`,
    );
  };
  const run = async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const mailboxTurn = await resolveMailboxTurnWork(context);
    if (mailboxTurn) {
      return await conversationTurnWorker(context, mailboxTurn);
    }
    const invocationId = await resolveAgentInvocationId(context);
    if (invocationId) {
      return await invocationWorker(context, invocationId);
    }
    const dispatchId = await resolveAgentDispatchId(context);
    if (dispatchId) {
      return await dispatchWorker(context, dispatchId);
    }
    return await destinationWorker(context);
  };
  return {
    conversationStore: options.conversationStore,
    queue: options.queue,
    run,
    runtime,
    state: options.state,
  };
}
