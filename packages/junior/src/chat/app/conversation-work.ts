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
  failStoppedDispatch,
} from "@/chat/agent-dispatch/work";
import { stopChildAgentsOf } from "@/chat/child-agents/stop";
import { logException, withLogContext } from "@/chat/logging";
import { resumeForPersonInput } from "@/chat/conversations/session-stop";
import { ownsLocation } from "@/chat/conversations/kind-behavior";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { runConversation } from "@/chat/task-execution/run-conversation";
import {
  getDispatchConversationId,
  getDispatchInputMessageId,
} from "@/chat/agent-dispatch/store";
import { createSlackRuntime } from "./factory";
import type { JuniorRuntimeServiceOverrides } from "./services";
import { createSlackSystemTurnDelivery } from "@/chat/providers/slack/system-turn";
import type { SendPluginTask } from "@/chat/plugins/task-runner";

type SlackRuntime = ReturnType<typeof createSlackRuntime>;

interface ConversationWorkOptions {
  agentRunner: AgentRunner;
  conversationStore: ConversationStore;
  getSlackAdapter: () => SlackAdapter;
  queue: ConversationWorkQueue;
  sendPluginTask: SendPluginTask;
  services?: JuniorRuntimeServiceOverrides | undefined;
  state?: StateAdapter;
  /** Keeps background work started by turns, such as titles, alive. */
  waitUntil?: (task: Promise<unknown>) => void;
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
    sendPluginTask: options.sendPluginTask,
    services: {
      ...options.services,
      agentRunner: options.agentRunner,
    },
    waitUntil: options.waitUntil,
  });
  const runtime = options.wrapRuntime?.(baseRuntime) ?? baseRuntime;
  const slackWorker = createSlackConversationWorker({
    getSlackAdapter: options.getSlackAdapter,
    runNextPausedTurn: async (conversationId, runOptions) =>
      await runNextPausedTurn(
        conversationId,
        {
          agentRunner: options.agentRunner,
          pausedTurns,
          sendPluginTask: options.sendPluginTask,
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
          pausedTurns,
          sendPluginTask: options.sendPluginTask,
        },
        { checkIn: hooks.checkIn, shouldYield: hooks.shouldYield },
      );
    },
    runTurn: runtime.runDispatchTurn,
  });
  const conversationTurnWorker = createConversationTurnWorker(
    options.agentRunner,
    createSlackSystemTurnDelivery({
      getSlackAdapter: options.getSlackAdapter,
      state: options.state,
    }),
    { queue: options.queue, state: options.state },
  );
  const runWithStopCascade = async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    // A run can see its stop late. Then it stops the child agents that it
    // spawned or gave new work to after the stop.
    const readStopSignal = context.stopSignal;
    let stopSignal: AbortSignal | undefined;
    const stopLateChildAgents = async () => {
      if (stopSignal?.aborted) {
        await stopChildAgentsOf(context.conversationId, options.state);
      }
    };
    let result: ConversationWorkerResult;
    try {
      result = await runConversation(
        {
          ...context,
          stopSignal: readStopSignal
            ? () => (stopSignal = readStopSignal())
            : undefined,
        },
        {
          destinations: { slack: slackWorker },
          runDispatch: dispatchWorker,
          runTurn: conversationTurnWorker,
          state: options.state,
        },
      );
    } catch (error) {
      // After a seen stop, the run throws only when saving the cancelled Turn
      // fails. With retries left, `recordConversationRetry` keeps the `runId`,
      // so the retried run sees the stop and cascades. On the final attempt,
      // only this cascade stops the late child agents. The run's own error
      // wins over a failed cascade.
      await stopLateChildAgents().catch((cascadeError: unknown) => {
        logException(cascadeError, "conversation.stop.cascade.failed");
      });
      throw error;
    }
    await stopLateChildAgents();
    return result;
  };
  const run = async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    // A person's input ends a stop, on a root or a child.
    await resumeForPersonInput(
      context.conversationId,
      context.attempt.messages,
    );
    const conversation = await options.conversationStore.get({
      conversationId: context.conversationId,
    });
    // A Conversation with its own Location, such as a Slack Conversation
    // that moved into a Space, runs as a root, so it still gets Slack work.
    const topLevel = !conversation || ownsLocation(conversation);
    // Bind the tree root once, so spans of child agents count by root.
    return await withLogContext(
      {
        rootConversationId:
          conversation?.rootConversationId ??
          (topLevel ? context.conversationId : undefined),
      },
      () => runWithStopCascade(context),
    );
  };
  return {
    beforeWorkStops: failStoppedDispatch,
    conversationStore: options.conversationStore,
    getSlackAdapter: options.getSlackAdapter,
    queue: options.queue,
    run,
    runtime,
    state: options.state,
    waitUntil: options.waitUntil,
  };
}
