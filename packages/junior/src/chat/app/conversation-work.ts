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
  createChildConversationWorker,
  enqueueAgentInvocationResult,
  enqueueAgentMessageToParent,
  withAgentInvocationResultActors,
} from "@/chat/agent-invocations/result";
import { stopChildAgentsOf } from "@/chat/agent-invocations/stop";
import { botConfig } from "@/chat/config";
import { logException } from "@/chat/logging";
import { skipInputAfterConversationStop } from "@/chat/conversations/session-stop";
import { resolveThreadTurnWork } from "@/chat/agent-invocations/thread-turn";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import { endActiveAgentInvocations } from "@/chat/agent-invocations/work";
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
    ...(options.sendPluginTask
      ? { sendPluginTask: options.sendPluginTask }
      : undefined),
    services: {
      ...options.services,
      agentRunner: options.agentRunner,
    },
    waitUntil: options.waitUntil,
  });
  const runtime = options.wrapRuntime?.(baseRuntime) ?? baseRuntime;
  const scheduleCompletedPluginTasks = options.sendPluginTask
    ? async (
        params: Parameters<typeof scheduleSessionCompletedPluginTasks>[0],
      ) =>
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
        { checkIn: hooks.checkIn, shouldYield: hooks.shouldYield },
      );
    },
    runTurn: runtime.runDispatchTurn,
  });
  const sendResult = async (
    invocation: TerminalAgentInvocation,
  ): Promise<void> =>
    await enqueueAgentInvocationResult(invocation, {
      queue: options.queue,
      state: options.state,
    });
  const childWorker = createChildConversationWorker(options.agentRunner, {
    sendResult,
    maxAgentDepth: botConfig.maxAgentDepth,
    queue: options.queue,
    state: options.state,
  });
  const conversationTurnWorker = createConversationTurnWorker(
    options.agentRunner,
    createSlackSystemTurnDelivery({
      getSlackAdapter: options.getSlackAdapter,
      state: options.state,
    }),
  );
  // A Slack Destination uses the Slack worker. All other root work must have
  // been selected above this function.
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
  const runRoot = async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const mailboxTurn = await resolveMailboxTurnWork(context);
    if (mailboxTurn) {
      const work = await withAgentInvocationResultActors(mailboxTurn);
      if (!work) {
        // A stop skipped every child result in this input.
        await context.attempt.ack();
        return { status: "completed" };
      }
      return await conversationTurnWorker(context, work);
    }
    const dispatchId = await resolveAgentDispatchId(context);
    if (dispatchId) {
      return await dispatchWorker(context, dispatchId);
    }
    return await destinationWorker(context);
  };
  const run = async (
    attemptContext: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    // Apply a session stop to automated input, on a root or a child.
    const stopped = await skipInputAfterConversationStop(attemptContext);
    if ("skipped" in stopped) {
      return stopped.skipped;
    }
    const { context } = stopped;
    // The stored kind decides the worker, so child work never reaches a root
    // worker. A child Turn can have any Source. A person's Turn in a Thread
    // runs like a web Turn on a root. Agent invocations, their input, and
    // watch Events keep the child worker.
    const conversation = await options.conversationStore.get({
      conversationId: context.conversationId,
    });
    if (conversation?.kind === "thread") {
      const threadTurn = await resolveThreadTurnWork(context);
      if (!threadTurn) {
        return await childWorker(context);
      }
      // A person's new input supersedes an open Agent invocation, as new
      // input does on a root. It waits behind a running or yielded one.
      if (threadTurn.kind === "mailbox") {
        await endActiveAgentInvocations(context.conversationId, {
          enqueueMessage: async (sender, messageKey, text) =>
            await enqueueAgentMessageToParent({
              messageKey,
              queue: options.queue,
              sender,
              state: options.state,
              text,
            }),
          errorMessage:
            "A person sent a Message in this Thread, so this task ended without a result. Send messageAgent again if you still need this work.",
          sendResult,
        });
      }
      return await conversationTurnWorker(context, threadTurn);
    }
    if (conversation?.parentConversationId) {
      return await childWorker(context);
    }
    // A root's run can see its stop late. Then it stops the child agents that
    // it spawned or gave new work to after the stop, as a child's worker does.
    const readStopSignal = context.stopSignal;
    let stopSignal: AbortSignal | undefined;
    const stopLateChildAgents = async () => {
      if (stopSignal?.aborted) {
        await stopChildAgentsOf(context.conversationId, options.state);
      }
    };
    let result: ConversationWorkerResult;
    try {
      result = await runRoot({
        ...context,
        stopSignal: readStopSignal
          ? () => (stopSignal = readStopSignal())
          : undefined,
      });
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
  return {
    conversationStore: options.conversationStore,
    queue: options.queue,
    run,
    runtime,
    state: options.state,
    waitUntil: options.waitUntil,
  };
}
