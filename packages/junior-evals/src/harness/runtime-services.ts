/**
 * Eval-local runtime service overrides: the agent runner wrapper and vision context.
 */
import { readFile } from "node:fs/promises";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { executeAgentRun } from "@/chat/agent";
import { actorFromRun } from "@/chat/agent/types";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { addAgentTurnUsage } from "@/chat/usage";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { projectTimedOutToolResult } from "@/chat/tool-support/timed-out-tool-result";
import type { ToolHooks } from "@/chat/tools/types";
import { createMemoryAttachmentStorage } from "../fixtures/attachment-storage";
import { createMockImageGenerateDeps } from "../fixtures/image-generate";
import {
  type EvalScenario,
  type SteeringDelivery,
  type EvalToolInvocation,
  type EvalThreadRecord,
  type RuntimeObservations,
} from "./types";
import {
  createReplayWebFetchDeps,
  createReplayWebSearchDeps,
} from "./replay-tools";
import {
  resolveEvalRelativePath,
  type HarnessEnvironment,
} from "./environment";
import { buildRuntimeThreadId, buildThreadReplyFromMessage } from "./threads";

function toEvalToolInvocation(input: {
  params: Record<string, unknown>;
  toolCallId?: string;
  toolName: string;
}): EvalToolInvocation {
  const invocation: EvalToolInvocation = {
    tool: input.toolName,
    arguments: input.params,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  };

  if (input.toolName === "bash" && typeof input.params.command === "string") {
    invocation.bash_command = input.params.command.trim();
  }

  if (
    input.toolName === "loadSkill" &&
    typeof input.params.skill_name === "string"
  ) {
    invocation.skill_name = input.params.skill_name.trim();
  }

  if (
    input.toolName === "callMcpTool" &&
    typeof input.params.tool_name === "string"
  ) {
    invocation.mcp_tool_name = input.params.tool_name.trim();
    if (
      input.params.arguments &&
      typeof input.params.arguments === "object" &&
      !Array.isArray(input.params.arguments)
    ) {
      invocation.mcp_arguments = input.params.arguments as Record<
        string,
        unknown
      >;
    }
  }

  return invocation;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Eval reply aborted");
}

async function raceWithAbort<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  let removeAbortListener = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const handleAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () =>
      signal.removeEventListener("abort", handleAbort);
  });
  const pending = operation();
  try {
    return await Promise.race([pending, abortPromise]);
  } finally {
    removeAbortListener();
    // The agent must finish its abort cleanup before the harness clears state
    // or closes the database. Preserve the original result or abort reason.
    await Promise.allSettled([pending]);
  }
}

/** Build the eval-local runtime service overrides for one scenario. */
export function buildRuntimeServices(
  scenario: EvalScenario,
  env: HarnessEnvironment,
  threadRecordsById: Map<string, EvalThreadRecord>,
  observations: RuntimeObservations,
  steeringDelivery: SteeringDelivery,
  signal?: AbortSignal,
): JuniorRuntimeServiceOverrides {
  const replyTexts = scenario.overrides?.reply_texts ?? [];
  const replyTimeoutMs =
    scenario.overrides?.reply_timeout_ms &&
    scenario.overrides.reply_timeout_ms > 0
      ? scenario.overrides.reply_timeout_ms
      : Number.parseInt(process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "60000", 10);
  if (
    !Number.isInteger(replyTimeoutMs) ||
    replyTimeoutMs <= 0 ||
    replyTimeoutMs > 60_000
  ) {
    throw new Error(
      `Eval reply timeout must be an integer from 1 to 60000 milliseconds, got ${replyTimeoutMs}`,
    );
  }
  const replyState = { successfulCount: 0 };
  let activeTurnCompactionInjected = false;
  let timeoutResumeInjected = false;
  // Match production agent runs: sendFiles stores durable attachment refs.
  const attachmentStorage = createMemoryAttachmentStorage();

  const services: JuniorRuntimeServiceOverrides = {
    agentRunner: {
      run: async (request) => {
        const pendingSteeringDelivery = steeringDelivery.deliver;
        const runRequest = pendingSteeringDelivery
          ? {
              ...request,
              durability: {
                ...request.durability,
                onInputCommitted: async () => {
                  await request.durability?.onInputCommitted?.();
                  if (steeringDelivery.deliver !== pendingSteeringDelivery) {
                    return;
                  }
                  steeringDelivery.deliver = undefined;
                  await pendingSteeringDelivery();
                },
              },
            }
          : request;
        const timeoutResume = scenario.overrides?.timeout_resume;
        const activeTurnCompaction = scenario.overrides?.active_turn_compaction;
        if (activeTurnCompaction && !activeTurnCompactionInjected) {
          activeTurnCompactionInjected = true;
          await runRequest.durability?.onInputCommitted?.();
          const nowMs = Date.now();
          const actor = actorFromRun(runRequest);
          const piMessages = [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `<${TURN_CONTEXT_TAG}>\nEval continuation fixture.\n</${TURN_CONTEXT_TAG}>`,
                },
              ],
              timestamp: nowMs,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: renderCurrentInstruction(runRequest.instruction.text),
                },
              ],
              timestamp: nowMs + 1,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\n${activeTurnCompaction.summary}`,
                },
              ],
              timestamp: nowMs + 2,
            },
          ] as PiMessage[];
          const sessionRecord = await upsertTurnRecord({
            conversationId: runRequest.conversationId,
            turnId: runRequest.turnId,
            sliceId: 1,
            state: "paused",
            piMessages,
            resumeReason: "yield",
            destination: runRequest.destination,
            source: runRequest.source,
            surface: runRequest.surface,
            actor,
            trailingMessageProvenance: [
              { authority: "instruction", actor },
              { authority: "context" },
            ],
            turnStartMessageIndex: 0,
          });
          return {
            status: "suspended",
            reason: "yield" as const,
            resumeVersion: sessionRecord.version,
          };
        }
        if (timeoutResume && !timeoutResumeInjected) {
          timeoutResumeInjected = true;
          await runRequest.durability?.onInputCommitted?.();
          const nowMs = Date.now();
          const toolCallId = "eval-timeout-resume-tool-call";
          const abortedAttempt = {
            target: timeoutResume.tool_name,
            aborted: true,
          };
          const timedOutResult = projectTimedOutToolResult({
            content: [{ type: "text", text: JSON.stringify(abortedAttempt) }],
            details: abortedAttempt,
          });
          if (
            !timedOutResult?.content ||
            timedOutResult.details === undefined
          ) {
            throw new Error("Failed to build timeout continuation fixture");
          }
          const piMessages = [
            {
              role: "user",
              content: [{ type: "text", text: runRequest.instruction.text }],
              timestamp: nowMs,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: timeoutResume.tool_name,
                  arguments: timeoutResume.arguments,
                },
              ],
              stopReason: "toolUse",
              api: "eval-timeout-resume",
              provider: "eval-timeout-resume",
              model: "xai/grok-4.5",
              timestamp: nowMs,
              usage: { input: 0, output: 0, totalTokens: 0 },
            },
            {
              role: "toolResult",
              toolCallId,
              toolName: timeoutResume.tool_name,
              content: timedOutResult.content,
              details: timedOutResult.details,
              isError: timedOutResult.isError,
              timestamp: nowMs,
            },
          ] as PiMessage[];
          const sessionRecord = await upsertTurnRecord({
            conversationId: runRequest.conversationId,
            turnId: runRequest.turnId,
            sliceId: 2,
            state: "paused",
            piMessages,
            resumeReason: "timeout",
            resumedFromSliceId: 1,
            destination: runRequest.destination,
            source: runRequest.source,
            surface: runRequest.surface,
            actor: actorFromRun(runRequest),
            errorMessage: "Agent turn timed out at the eval fixture boundary",
            turnStartMessageIndex: 0,
          });
          return {
            status: "suspended",
            reason: "timeout" as const,
            resumeVersion: sessionRecord.version,
          };
        }
        const mockImageGeneration = scenario.overrides?.mock_image_generation;
        const replyText = replyTexts[replyState.successfulCount];
        let scriptedStream: ReturnType<typeof createFauxCore> | undefined;
        if (typeof replyText === "string") {
          scriptedStream = createFauxCore({
            api: "eval",
            provider: "eval",
          });
          scriptedStream.setResponses([fauxAssistantMessage(replyText)]);
        }

        const baseToolOverrides: ToolHooks["toolOverrides"] = {
          ...(request.environment?.toolOverrides ?? {}),
        };
        const viewImageFixtures = new Map(
          scenario.overrides?.view_image_files?.map((fixture) => [
            fixture.path,
            resolveEvalRelativePath(fixture.source),
          ]) ?? [],
        );
        const toolOverrides = {
          ...baseToolOverrides,
          webFetch: createReplayWebFetchDeps(baseToolOverrides),
          webSearch: createReplayWebSearchDeps(baseToolOverrides),
          ...(mockImageGeneration
            ? { imageGenerate: createMockImageGenerateDeps() }
            : {}),
          ...(viewImageFixtures.size > 0
            ? {
                viewImage: {
                  readFile: async (imagePath: string) => {
                    const sourcePath = viewImageFixtures.get(imagePath);
                    return sourcePath ? await readFile(sourcePath) : null;
                  },
                },
              }
            : {}),
        };
        try {
          const pendingToolInvocations: EvalToolInvocation[] = [];
          const replySignal = AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(replyTimeoutMs),
          ]);
          const outcome = await raceWithAbort(replySignal, () =>
            executeAgentRun(
              {
                ...runRequest,
                signal: replySignal,
                deadlineAtMs: Math.min(
                  runRequest.deadlineAtMs ?? Number.POSITIVE_INFINITY,
                  Date.now() + replyTimeoutMs,
                ),
                environment: {
                  ...runRequest.environment,
                  attachmentStorage:
                    runRequest.environment?.attachmentStorage ??
                    attachmentStorage,
                  ...(env.configuredSkillDirs.length > 0
                    ? { skillDirs: env.configuredSkillDirs }
                    : {}),
                  toolOverrides,
                },
                onEvent: async (event) => {
                  await runRequest.onEvent?.(event);
                  if (event.type === "tool_started") {
                    const evalInvocation = toEvalToolInvocation({
                      params: event.params,
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                    });
                    observations.toolInvocations.push(evalInvocation);
                    pendingToolInvocations.push(evalInvocation);
                    return;
                  }
                  if (event.type !== "tool_finished") {
                    return;
                  }
                  const result = event.report;
                  const pendingIndex = pendingToolInvocations.findIndex(
                    (candidate) => candidate.toolCallId === result.toolCallId,
                  );
                  if (pendingIndex === -1) {
                    return;
                  }
                  const [invocation] = pendingToolInvocations.splice(
                    pendingIndex,
                    1,
                  );
                  invocation.completed = true;
                  invocation.ok = result.ok;
                  if (result.error) {
                    invocation.error = result.error;
                  }
                  if (result.result !== undefined) {
                    invocation.result = result.result;
                  }
                },
              },
              scriptedStream?.stream,
            ),
          );
          const usage =
            outcome.status === "completed"
              ? outcome.result.diagnostics.usage
              : outcome.usage;
          observations.usage = addAgentTurnUsage(observations.usage, usage);
          if (outcome.status === "completed") {
            const diagnostics = outcome.result.diagnostics;
            observations.modelIds.add(diagnostics.modelId);
            if (diagnostics.outcome !== "success") {
              observations.errors.push(
                new Error(
                  `Eval agent ${diagnostics.outcome}: ${diagnostics.errorMessage ?? "no successful reply"}`,
                  { cause: diagnostics.providerError },
                ),
              );
            }
          }
          replyState.successfulCount += 1;
          return outcome;
        } catch (error) {
          // Production delivers a safe failure reply. Keep the original failure
          // so a negative rubric cannot score that fallback as a successful run.
          observations.errors.push(error);
          throw error;
        }
      },
    },
    visionContext: {
      listThreadReplies: async ({ channelId, threadTs, targetMessageTs }) => {
        const threadId = buildRuntimeThreadId({
          id: `slack:${channelId}:${threadTs}`,
          channel_id: channelId,
          thread_ts: threadTs,
        });
        const replies = (threadRecordsById.get(threadId)?.transcript ?? []).map(
          (message) => buildThreadReplyFromMessage(threadTs, message),
        );
        if (!targetMessageTs || targetMessageTs.length === 0) {
          return replies;
        }
        const targets = new Set(targetMessageTs);
        return replies.filter(
          (reply) => typeof reply.ts === "string" && targets.has(reply.ts),
        );
      },
    },
  };
  return services;
}
