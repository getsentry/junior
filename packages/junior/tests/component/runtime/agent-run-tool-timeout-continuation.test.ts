import { Buffer } from "node:buffer";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";

const observations = vi.hoisted(() => ({
  continuationMessages: [] as Array<{
    role?: unknown;
    content?: unknown;
  }>,
  providerCalls: 0,
  toolAborted: false,
  toolExecutions: [] as string[],
  toolStarted: false,
}));

vi.mock("@/chat/pi/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/pi/client")>();
  return {
    ...actual,
    completeObject: async () => ({
      object: {
        reasoning_level: "medium",
        profile: "standard",
        confidence: 1,
        reason: "test-router",
      },
    }),
  };
});

// Keep the provider as the integration boundary. The real Pi loop executes
// the tool, handles abort, persists the toolResult, and invokes continue().
vi.mock("@/chat/pi/traced-stream", () => ({
  createTracedStreamFn:
    () =>
    async (
      model: { id: string },
      context: any,
      options?: { signal?: AbortSignal },
    ) => {
      observations.providerCalls += 1;
      const call = observations.providerCalls;
      if (call > 1) {
        observations.continuationMessages = context.messages ?? [];
      }

      const timeoutContinuation =
        !options?.signal?.aborted &&
        JSON.stringify(context.messages ?? []).includes('"timed_out":true');
      const message =
        call === 1
          ? {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "bash-call-1",
                  name: "bash",
                  arguments: {
                    command: "run-the-targeted-cloudflare-test",
                    timeoutMs: 180_000,
                  },
                },
              ],
              stopReason: "toolUse",
              api: "test",
              provider: "test",
              model: model.id,
              timestamp: Date.now(),
              usage: { input: 2, output: 1, totalTokens: 3 },
            }
          : timeoutContinuation && observations.toolExecutions.length === 1
            ? {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "bash-call-2",
                    name: "bash",
                    arguments: {
                      command: "rerun-the-targeted-cloudflare-test",
                      timeoutMs: 180_000,
                    },
                  },
                ],
                stopReason: "toolUse",
                api: "test",
                provider: "test",
                model: model.id,
                timestamp: Date.now(),
                usage: { input: 4, output: 3, totalTokens: 7 },
              }
            : timeoutContinuation
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "The targeted test passed and the pull request was created.",
                    },
                  ],
                  stopReason: "stop",
                  api: "test",
                  provider: "test",
                  model: model.id,
                  timestamp: Date.now(),
                  usage: { input: 4, output: 3, totalTokens: 7 },
                }
              : {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "The work was interrupted during the targeted Cloudflare test rerun.",
                    },
                  ],
                  stopReason: "stop",
                  api: "test",
                  provider: "test",
                  model: model.id,
                  timestamp: Date.now(),
                  usage: { input: 4, output: 3, totalTokens: 7 },
                };

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: { ...message, content: [] } };
          yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
}));

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandbox: () => ({
    captureRepositoryInstructions: async () => undefined,
    workspace: {
      readFileToBuffer: async () => Buffer.from("", "utf8"),
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFiles: async () => undefined,
    },
    tools: {
      supports: (toolName: string) => toolName === "bash",
      execute: async ({
        input,
        signal,
      }: {
        input: { command?: string };
        signal?: AbortSignal;
      }) => {
        const command = input.command ?? "";
        observations.toolExecutions.push(command);
        if (observations.toolExecutions.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  target: command,
                  stdout: "targeted Cloudflare test passed",
                  exit_code: 0,
                }),
              },
            ],
            details: {
              target: command,
              stdout: "targeted Cloudflare test passed",
              exit_code: 0,
            },
          };
        }
        observations.toolStarted = true;
        await new Promise<void>((resolve) => {
          const abort = () => {
            observations.toolAborted = true;
            resolve();
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
        const details = {
          target: "run-the-targeted-cloudflare-test",
          aborted: true,
          exit_code: 130,
          stderr: "Command aborted because the agent turn was cancelled.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      },
    },
    sandboxRef: () => undefined,
    close: vi.fn(),
  }),
}));

vi.mock("@/chat/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/skills")>()),
  discoverSkills: async () => [],
  findSkillByName: () => null,
  parseSkillInvocation: () => null,
}));

import { executeAgentRun } from "@/chat/agent";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;

async function waitForToolStart(): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (observations.toolStarted) {
      return;
    }
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
  throw new Error("Expected sandbox tool execution to start");
}

describe("tool timeout continuation composition", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    observations.continuationMessages = [];
    observations.providerCalls = 0;
    observations.toolAborted = false;
    observations.toolExecutions = [];
    observations.toolStarted = false;
    await disconnectStateAdapter();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    if (ORIGINAL_STATE_ADAPTER === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = ORIGINAL_STATE_ADAPTER;
    }
  });

  it("continues using tools after a tool is interrupted at the turn deadline", async () => {
    const conversationId = "local:test:tool-timeout-continuation";
    const turnId = "turn-tool-timeout-continuation";
    const request = {
  conversationId: conversationId,
  turnId: turnId,
  instruction:   {
  text: "Run the targeted test and create the PR.",
  },
  destination: { platform: "local" as const, conversationId },
  source: createLocalSource(conversationId),
};

    const suspendedPromise = executeAgentRun({
      ...request,
      deadlineAtMs: Date.now() + 10_000,
    });
    await waitForToolStart();
    await vi.advanceTimersByTimeAsync(10_000);
    // Let the runtime's bounded abort-settlement grace window expire if needed.
    await vi.advanceTimersByTimeAsync(5_000);
    const suspended = await suspendedPromise;

    expect(observations.toolStarted).toBe(true);
    expect(observations.toolAborted).toBe(true);
    expect(suspended.status).toBe("suspended");
    const suspendedRecord = await getTurnRecord(conversationId, turnId);
    expect(suspendedRecord).toMatchObject({
      state: "paused",
      resumeReason: "timeout",
    });
    expect(suspendedRecord?.piMessages.at(-1)).toMatchObject({
      role: "toolResult",
      isError: false,
      details: {
        target: "run-the-targeted-cloudflare-test",
        timed_out: true,
      },
    });
    const suspendedToolResult = JSON.stringify(
      suspendedRecord?.piMessages.at(-1),
    );
    expect(suspendedToolResult).not.toMatch(
      /cancelled|turn_deadline|execution_slice|unconfirmed|deadline/i,
    );

    const resumed = await executeAgentRun(request);

    expect(observations.continuationMessages.at(-1)).toMatchObject({
      role: "toolResult",
    });
    expect(observations.toolExecutions).toEqual([
      "run-the-targeted-cloudflare-test",
      "rerun-the-targeted-cloudflare-test",
    ]);
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;
    expect(resumed.result.text).not.toMatch(/interrupted/i);
  });
});
