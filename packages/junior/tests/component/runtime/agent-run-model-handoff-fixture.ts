import { vi } from "vitest";
import { observations } from "./agent-run-model-handoff-state";

export { observations } from "./agent-run-model-handoff-state";

vi.mock("@/chat/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/config")>();
  const config = actual.readChatConfig({
    ...process.env,
    AI_HANDOFF_MODEL: "openai/gpt-5.6-sol",
    AI_MODEL_PROFILES: JSON.stringify({ coding: "openai/gpt-5.4" }),
  });
  return { ...actual, botConfig: config.bot };
});

vi.mock("@/chat/pi/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/pi/client")>();
  return {
    ...actual,
    completeObject: async () => {
      observations.routerCalls += 1;
      return {
        object: {
          reasoning_level: observations.routedReasoningLevel,
          profile: observations.routedModelProfile,
          confidence: 0.99,
          reason: "complex implementation",
        },
      };
    },
    completeText: async (args: { signal?: AbortSignal }) => {
      observations.handoffStatusBeforeSummary =
        observations.statuses.includes("Switching models");
      observations.summaryCalls += 1;
      if (observations.summaryPending) {
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            observations.summaryAborted = true;
            reject(args.signal?.reason);
          };
          if (args.signal?.aborted) {
            abort();
            return;
          }
          args.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return { text: "Implement the requested change and verify it." };
    },
  };
});

vi.mock("@/chat/pi/traced-stream", () => ({
  createTracedStreamFn:
    () => async (model: any, context: any, options: any) => {
      observations.providerCalls += 1;
      observations.reasoningLevels.push(options?.reasoning ?? "unset");
      const call = observations.providerCalls;
      const routedToHandoff =
        call === 1 && observations.routedModelProfile === "handoff";
      const sequencedProfile = observations.requestedProfileSequence[call - 1];
      const shouldRequestHandoff =
        sequencedProfile !== undefined ||
        (call === 1 &&
          (!routedToHandoff || observations.requestHandoffAfterRouting));
      const requestedProfile =
        sequencedProfile ?? observations.requestedProfile;
      if (call === 1) {
        observations.initialModelId = model.id;
        observations.initialImagePart = (
          (context.messages ?? []) as Array<{
            content?: Array<{
              type?: unknown;
              data?: unknown;
              mimeType?: unknown;
            }>;
          }>
        )
          .flatMap((message) => message.content ?? [])
          .find((part) => part.type === "image") as
          | { type: unknown; data: unknown; mimeType: unknown }
          | undefined;
        observations.initialToolNames = (context.tools ?? []).map(
          (tool: { name: string }) => tool.name,
        );
        observations.initialHandoffProfiles =
          (context.tools ?? []).find(
            (tool: { name: string }) => tool.name === "handoff",
          )?.parameters?.properties?.profile?.enum ?? [];
      } else {
        observations.afterHandoffModelId = model.id;
        observations.afterHandoffMessages = context.messages ?? [];
        observations.afterHandoffToolNames = (context.tools ?? []).map(
          (tool: { name: string }) => tool.name,
        );
        observations.afterHandoffProfiles =
          (context.tools ?? []).find(
            (tool: { name: string }) => tool.name === "handoff",
          )?.parameters?.properties?.profile?.enum ?? [];
      }

      const text =
        routedToHandoff && !shouldRequestHandoff
          ? "Handoff model completed it."
          : call === 1
            ? observations.progressTool
              ? "Let me do that now."
              : "The standard model started an answer that must be hidden."
            : observations.mixedBatch
              ? "Standard model recovered safely."
              : "Handoff model completed it.";
      const content: Array<Record<string, unknown>> = [{ type: "text", text }];
      if (shouldRequestHandoff) {
        content.push({
          type: "toolCall",
          id: observations.progressTool
            ? "progress-call-1"
            : `handoff-call-${call}`,
          name: observations.progressTool ? "reportProgress" : "handoff",
          arguments: observations.progressTool
            ? { message: "Checking details" }
            : requestedProfile === undefined
              ? {}
              : { profile: requestedProfile },
        });
        if (observations.mixedBatch && !observations.progressTool) {
          content.push({
            type: "toolCall",
            id: "bash-call-1",
            name: "bash",
            arguments: { command: "touch should-not-run" },
          });
        }
      }
      const message = {
        role: "assistant",
        content,
        stopReason: shouldRequestHandoff ? "toolUse" : "stop",
        api: "test",
        provider: "test",
        model: model.id,
        timestamp: Date.now(),
        usage:
          call === 1
            ? { input: 2, output: 1, totalTokens: 3 }
            : observations.mixedBatch
              ? { input: 2, output: 2, totalTokens: 4 }
              : { input: 4, output: 3, totalTokens: 7 },
      };
      const partial = { ...message, content: [] };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: {
              ...message,
              content: [{ type: "text", text }],
            },
          };
          yield {
            type: "done",
            reason: message.stopReason,
            message,
          };
        },
        result: async () => message,
      };
    },
}));

vi.mock("@/chat/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/skills")>()),
  discoverSkills: async () => [],
  findSkillByName: () => null,
  parseSkillInvocation: () => null,
}));

type ExecuteAgentRun = typeof import("@/chat/agent").executeAgentRun;

/** Run the agent after this module installs its model mocks. */
export const executeAgentRun: ExecuteAgentRun = async (...args) => {
  const agent = await import("@/chat/agent");
  return agent.executeAgentRun(...args);
};

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;

/** Reset shared model observations before one handoff component test. */
export async function resetHandoffTestState(): Promise<void> {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  observations.afterHandoffModelId = "";
  observations.afterHandoffMessages = [];
  observations.afterHandoffProfiles = [];
  observations.afterHandoffToolNames = [];
  observations.initialModelId = "";
  observations.initialImagePart = undefined;
  observations.initialHandoffProfiles = [];
  observations.initialToolNames = [];
  observations.mixedBatch = false;
  observations.progressTool = false;
  observations.providerCalls = 0;
  observations.routerCalls = 0;
  observations.requestedProfile = "handoff";
  observations.requestedProfileSequence = [];
  observations.requestHandoffAfterRouting = false;
  observations.routedModelProfile = "standard";
  observations.routedReasoningLevel = "high";
  observations.reasoningLevels = [];
  observations.summaryCalls = 0;
  observations.summaryAborted = false;
  observations.summaryPending = false;
  observations.handoffStatusBeforeSummary = false;
  observations.statuses = [];
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  await disconnectStateAdapter();
}

/** Restore shared state after one handoff component test. */
export async function restoreHandoffTestState(): Promise<void> {
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  await disconnectStateAdapter();
  if (ORIGINAL_STATE_ADAPTER === undefined) {
    delete process.env.JUNIOR_STATE_ADAPTER;
  } else {
    process.env.JUNIOR_STATE_ADAPTER = ORIGINAL_STATE_ADAPTER;
  }
}
