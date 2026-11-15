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
  // Holds the start of the second parallel call, so the deadline passes
  // while Pi prepares the batch.
  releaseSecondRead: undefined as (() => void) | undefined,
  secondReadPreparing: false,
  toolAborted: false,
  toolExecutions: [] as string[],
  toolStarted: false,
}));

vi.mock("@/chat/conversations/projection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/chat/conversations/projection")>();
  return {
    ...actual,
    recordToolExecutionStarted: async (
      args: Parameters<typeof actual.recordToolExecutionStarted>[0],
    ) => {
      if (args.toolCallId === "read-call-2") {
        observations.secondReadPreparing = true;
        await new Promise<void>((resolve) => {
          observations.releaseSecondRead = resolve;
        });
      }
      return await actual.recordToolExecutionStarted(args);
    },
  };
});

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
// the tools, handles abort, persists the toolResults, and invokes continue().
vi.mock("@/chat/pi/traced-stream", () => ({
  createTracedStreamFn:
    () =>
    async (
      model: { id: string },
      context: any,
      options?: { signal?: AbortSignal },
    ) => {
      // Pi still calls the model after a batch that the deadline aborted.
      // A provider answers an aborted request with an aborted message.
      const aborted = options?.signal?.aborted === true;
      if (!aborted) {
        observations.providerCalls += 1;
      }
      const call = observations.providerCalls;
      if (call === 2 && !aborted) {
        observations.continuationMessages = context.messages ?? [];
      }
      const toolCall = (
        id: string,
        name: string,
        args: Record<string, unknown>,
      ) => ({
        type: "toolCall",
        id,
        name,
        arguments: args,
      });
      // The first slice reads two files in one parallel batch. The resumed
      // slice runs the test, and the second deadline interrupts it.
      const content = aborted
        ? []
        : call === 1
          ? [
              toolCall("read-call-1", "readFile", { path: "/workspace/a.txt" }),
              toolCall("read-call-2", "readFile", { path: "/workspace/b.txt" }),
            ]
          : call === 2
            ? [
                toolCall("bash-call-1", "bash", {
                  command: "run-the-targeted-cloudflare-test",
                  timeoutMs: 180_000,
                }),
              ]
            : [{ type: "text", text: "Unexpected model call." }];
      const message = {
        role: "assistant",
        content,
        stopReason: aborted
          ? "aborted"
          : content[0]!.type === "toolCall"
            ? "toolUse"
            : "stop",
        api: "test",
        provider: "test",
        model: model.id,
        timestamp: Date.now(),
        usage: { input: 2, output: 1, totalTokens: 3 },
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
          target: command,
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

const ORIGINAL_STATE_ADAPTER = process.env["JUNIOR_STATE_ADAPTER"];

async function waitFor(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
  throw new Error(`Expected ${label}`);
}

describe("tool timeout continuation composition", () => {
  beforeEach(async () => {
    process.env["JUNIOR_STATE_ADAPTER"] = "memory";
    observations.continuationMessages = [];
    observations.providerCalls = 0;
    observations.releaseSecondRead = undefined;
    observations.secondReadPreparing = false;
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
      delete process.env["JUNIOR_STATE_ADAPTER"];
    } else {
      process.env["JUNIOR_STATE_ADAPTER"] = ORIGINAL_STATE_ADAPTER;
    }
  });

  it("continues using tools after a tool is interrupted at the turn deadline", async () => {
    const conversationId = "local:test:tool-timeout-continuation";
    const turnId = "turn-tool-timeout-continuation";
    const request = {
      conversationId: conversationId,
      turnId: turnId,
      instruction: {
        text: "Run the targeted test and create the PR.",
      },
      destination: { platform: "local" as const, conversationId },
      source: createLocalSource(conversationId),
    };

    // Pi prepares every call of a parallel batch before it starts them. The
    // deadline passes while it prepares the second call.
    const firstSlicePromise = executeAgentRun({
      ...request,
      deadlineAtMs: Date.now() + 10_000,
    });
    await waitFor(
      () => observations.secondReadPreparing,
      "the second parallel call to be prepared",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    observations.releaseSecondRead?.();
    // The run state store needs real time to save the batch.
    await new Promise<void>((resolve) => realSetTimeout(resolve, 500));
    await vi.advanceTimersByTimeAsync(5_000);
    const firstSlice = await firstSlicePromise;

    // Pi 0.85.1 does not start a prepared call after the abort, and stops
    // preparing the rest. Neither call reaches `afterToolCall`, so neither
    // gets the `timed_out` shape. On 0.84.1 the prepared first call still
    // ran with the aborted signal and got the `timed_out` shape.
    const abortedRead = (toolCallId: string) =>
      expect.objectContaining({
        role: "toolResult",
        toolCallId,
        toolName: "readFile",
        content: [{ type: "text", text: "Operation aborted" }],
        details: {},
        isError: true,
      });
    const abortedBatch = [
      abortedRead("read-call-1"),
      abortedRead("read-call-2"),
    ];
    expect(firstSlice.status).toBe("suspended");
    const firstRecord = await getTurnRecord(conversationId, turnId);
    expect(firstRecord?.piMessages.slice(-2)).toEqual(abortedBatch);

    const suspendedPromise = executeAgentRun({
      ...request,
      deadlineAtMs: Date.now() + 10_000,
    });
    await waitFor(() => observations.toolStarted, "the test command to start");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const suspended = await suspendedPromise;

    // The resumed slice gives the model the saved results unchanged.
    expect(observations.continuationMessages.slice(-2)).toEqual(abortedBatch);
    expect(observations.toolExecutions).toEqual([
      "run-the-targeted-cloudflare-test",
    ]);
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
  });
});
