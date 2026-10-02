/**
 * Eval-local runtime service overrides: the agent runner wrapper and vision context.
 */
import { readFile } from "node:fs/promises";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { executeAgentRun } from "@/chat/agent";
import { addAgentTurnUsage } from "@/chat/usage";
import type { ToolHooks } from "@/chat/tools/types";
import { createMemoryAttachmentStorage } from "../fixtures/attachment-storage";
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
  const turnTimeoutMs = scenario.overrides?.turn_timeout_ms;
  if (
    turnTimeoutMs !== undefined &&
    (!Number.isInteger(turnTimeoutMs) ||
      turnTimeoutMs <= 0 ||
      turnTimeoutMs >= replyTimeoutMs)
  ) {
    throw new Error(
      `Eval turn timeout must be an integer below the ${replyTimeoutMs}ms reply budget, got ${turnTimeoutMs}`,
    );
  }
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
            executeAgentRun({
              ...runRequest,
              signal: replySignal,
              // The runtime owns what happens at the deadline: it aborts
              // in-flight tools, records the boundary, and resumes the turn.
              deadlineAtMs: Math.min(
                runRequest.deadlineAtMs ?? Number.POSITIVE_INFINITY,
                Date.now() + (turnTimeoutMs ?? replyTimeoutMs),
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
            }),
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
