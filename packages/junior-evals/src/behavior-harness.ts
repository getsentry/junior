import type { SlackAdapter } from "@chat-adapter/slack";
import { type Message } from "chat";
import {
  attachHarnessRunToError,
  getHarnessRunFromError,
  serializeError,
} from "vitest-evals/harness";
import { resolveConversationTitle } from "@/chat/services/conversation-title";
import { toEvalHarnessRun } from "./eval-result";
import { createConversationWork } from "@/chat/app/conversation-work";
import { getConversationStore } from "@/chat/db";
import type { EmittedLogRecord } from "@/chat/logging";
import { getPlugins, setPlugins } from "@/chat/plugins/agent-hooks";
import { FakeSlackAdapter } from "@junior-tests/fixtures/slack-harness";
import { createConversationWorkQueueTestAdapter } from "@junior-tests/fixtures/conversation-work";
import { readCapturedSlackApiCalls } from "@junior-tests/msw/captured-slack-api-calls";
import { TEST_BOT_USER_ID } from "@junior-tests/fixtures/slack/factories/ids";
import { evalRuntimePlugins } from "./eval-plugin-fixtures";
import {
  type EvalEventThreadFixture,
  type EvalScenario,
  type EvalScenarioRunOptions,
  type SteeringDelivery,
  type EvalResult,
  type EvalThreadRecord,
  type QueueDelivery,
  type RuntimeObservations,
} from "./harness/types";
import {
  processEvalPluginTask,
  drainPendingEvalPluginTasks,
} from "./harness/plugin-tasks";
import { buildRuntimeServices } from "./harness/runtime-services";
import {
  setupHarnessEnvironment,
  teardownHarnessEnvironment,
} from "./harness/environment";
import {
  buildRuntimeThreadId,
  attachTranscriptAccessors,
  createEvalThread,
  recordPendingPosts,
} from "./harness/threads";
import {
  collectSlackArtifactsFromCapturedCalls,
  toEvalAssistantPost,
} from "./harness/slack-artifacts";
import { processEvents } from "./harness/event-processing";
import { preloadHistory } from "./harness/history";

function collectResults(
  threadRecordsById: Map<string, EvalThreadRecord>,
  slackAdapter: FakeSlackAdapter,
  logRecords: EmittedLogRecord[],
  observations: RuntimeObservations,
): EvalResult {
  recordPendingPosts(threadRecordsById, observations);
  const { canvases, channelPosts, filePosts, reactions } =
    collectSlackArtifactsFromCapturedCalls(readCapturedSlackApiCalls());
  const threadPosts = [...threadRecordsById.values()].flatMap((record) =>
    record.thread.posts.map((post) => ({
      ...toEvalAssistantPost(post),
      channel: record.thread.channelId,
      ...(record.thread.threadTs ? { thread_ts: record.thread.threadTs } : {}),
    })),
  );

  return {
    canvases,
    channelPosts,
    conversationIds: [...threadRecordsById.keys()],
    logRecords,
    authorizationCompletions: observations.authorizationCompletions,
    reactions,
    modelIds: [...observations.modelIds],
    posts: [...threadPosts, ...filePosts],
    sessionMessages: observations.sessionMessages,
    slackAdapter,
    toolInvocations: observations.toolInvocations,
    ...(observations.usage ? { usage: observations.usage } : {}),
  };
}

/** Run one scenario through the real runtime and collect its session and artifacts. */
export async function runEvalScenario(
  scenario: EvalScenario,
  options: EvalScenarioRunOptions = {},
): Promise<EvalResult> {
  const startedAt = Date.now();
  const logRecords = options.logRecords ?? [];
  const runtimePlugins = evalRuntimePlugins(
    scenario.overrides?.plugin_packages ?? [],
  );
  const env = await setupHarnessEnvironment(scenario, runtimePlugins);
  let previousPlugins: ReturnType<typeof setPlugins> | undefined;
  let runError: unknown;
  let result: EvalResult | undefined;
  const threadRecordsById = new Map<string, EvalThreadRecord>();

  try {
    const runtimePluginNames = new Set(
      runtimePlugins.map((plugin) => plugin.manifest.name),
    );
    const currentPlugins = getPlugins();
    previousPlugins = setPlugins([
      ...runtimePlugins,
      ...currentPlugins.filter(
        (plugin) => !runtimePluginNames.has(plugin.manifest.name),
      ),
    ]);
    const slackAdapter = new FakeSlackAdapter({ botUserId: TEST_BOT_USER_ID });
    const readyQueueDeliveries: QueueDelivery[] = [];
    const observations: RuntimeObservations = {
      errors: [],
      authorizationCompletions: [],
      modelIds: new Set(),
      sessionMessages: [],
      toolInvocations: [],
    };
    const channelStateById = new Map<
      string,
      { value: Record<string, unknown> }
    >();

    const getChannelStateRef = (
      channelId: string | undefined,
    ): { value: Record<string, unknown> } | undefined => {
      const normalized = channelId?.trim();
      if (!normalized) return undefined;
      const existing = channelStateById.get(normalized);
      if (existing) return existing;
      const created = { value: {} };
      channelStateById.set(normalized, created);
      return created;
    };

    const getThreadRecord = async (
      fixture: EvalEventThreadFixture,
    ): Promise<EvalThreadRecord> => {
      const runtimeThreadId = buildRuntimeThreadId(fixture);
      const existing = threadRecordsById.get(runtimeThreadId);
      if (existing) return existing;
      const thread = await createEvalThread({
        fixture,
        channelStateRef: getChannelStateRef(fixture.channel_id),
        stateAdapter: env.stateAdapter,
      });
      const transcript: Message[] = [];
      attachTranscriptAccessors(thread, transcript);
      const record = { thread, transcript, recordedPosts: 0 };
      threadRecordsById.set(runtimeThreadId, record);
      return record;
    };

    const conversationWorkQueue = createConversationWorkQueueTestAdapter();
    const steeringDelivery: SteeringDelivery = {};
    const services = buildRuntimeServices(
      scenario,
      env,
      threadRecordsById,
      observations,
      steeringDelivery,
      options.signal,
    );
    const evalAgentRunner = services.agentRunner;
    if (!evalAgentRunner) {
      throw new Error("Eval agent runner was not configured.");
    }

    // Compose the same Conversation work path as production. Wrap Delivery so
    // worker-claimed turns post through harness TestThreads.
    const conversationWork = createConversationWork({
      agentRunner: evalAgentRunner,
      conversationStore: getConversationStore(),
      getSlackAdapter: () => slackAdapter as unknown as SlackAdapter,
      queue: conversationWorkQueue,
      sendPluginTask: processEvalPluginTask,
      services,
      state: env.stateAdapter,
      wrapRuntime: (runtime) => ({
        ...runtime,
        async handleNewMention(thread, message, hooks) {
          await runtime.handleNewMention(
            threadRecordsById.get(thread.id)?.thread ?? thread,
            message,
            hooks,
          );
        },
        async handleSubscribedMessage(thread, message, hooks) {
          await runtime.handleSubscribedMessage(
            threadRecordsById.get(thread.id)?.thread ?? thread,
            message,
            hooks,
          );
        },
      }),
    });

    try {
      if (scenario.history?.length) {
        await preloadHistory({
          history: scenario.history,
          getThreadRecord,
          observations,
        });
      }
      await processEvents({
        scenario,
        env,
        agentRunner: evalAgentRunner,
        getSlackAdapter: () => slackAdapter,
        conversationWorkQueue,
        conversationWork,
        getThreadRecord,
        observations,
        readyQueueDeliveries,
        steeringDelivery,
        threadRecordsById,
        signal: options.signal,
      });

      if (observations.errors.length > 0) {
        throw new AggregateError(
          observations.errors,
          "Eval agent execution failed",
        );
      }
    } catch (error) {
      const run = toEvalHarnessRun(
        collectResults(
          threadRecordsById,
          slackAdapter,
          logRecords,
          observations,
        ),
        Date.now() - startedAt,
      );
      run.errors = [
        error,
        ...observations.errors.filter((cause) => cause !== error),
      ].map(serializeError);
      throw attachHarnessRunToError(error, run);
    }
    result = collectResults(
      threadRecordsById,
      slackAdapter,
      logRecords,
      observations,
    );
    return result;
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      // Titles are detached from delivery but must finish before SQL is closed.
      ...[...threadRecordsById.keys()].map((conversationId) => async () => {
        await resolveConversationTitle({ conversationId });
      }),
      drainPendingEvalPluginTasks,
      async () => {
        if (previousPlugins) setPlugins(previousPlugins);
        await teardownHarnessEnvironment(scenario, env);
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const error = new AggregateError(
        [...(runError ? [runError] : []), ...cleanupErrors],
        "Eval cleanup failed",
        { cause: runError ?? cleanupErrors[0] },
      );
      const run =
        getHarnessRunFromError(runError) ??
        (result ? toEvalHarnessRun(result, Date.now() - startedAt) : undefined);
      if (run) {
        run.errors.push(...cleanupErrors.map(serializeError));
        throw attachHarnessRunToError(error, run);
      }
      throw error;
    }
  }
}

// Compile-time guards for Thread and Message fakes are in tests/fixtures/slack-harness.ts.
