import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import { createResumeState } from "@/chat/agent/resume";
import {
  CODE_MODE_SCRIPT_TIMEOUT_MS,
  runCodeModeScript,
} from "@/chat/codemode/bridge";
import { botConfig } from "@/chat/config";
import { createToolActionReview } from "@/chat/guardian/gate";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { TURN_LIMIT_WRAP_UP_MESSAGE } from "@/chat/services/turn-limit";
import { createTools } from "@/chat/tools";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";
import { planToolExposure } from "@/chat/tool-exposure";
import { createToolPipeline } from "@/chat/tool-support/pi-tool-adapter";

const CONVERSATION_ID = "local:test:codemode-bridge";
const DESTINATION = {
  platform: "local",
  conversationId: CONVERSATION_ID,
} as const;
const SOURCE = createLocalSource(CONVERSATION_ID);
const CODEMODE_CALL_ID = "call-codemode";

const REVIEWED_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
} as const;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Guardian's model review is the only faked edge. It denies posts to
 * `#public` and allows everything else.
 */
function fakeGuardian() {
  return vi.fn<ToolActionReviewer["review"]>(async (proposal) =>
    proposal.input.channel === "#public"
      ? {
          decision: "deny",
          reason: "Private data would go to a public channel.",
          riskLevel: "high",
          rule: "data_exposure",
          userAuthorization: "low",
        }
      : {
          decision: "allow",
          reason: "The user asked for this.",
          riskLevel: "low",
          rule: "none",
          userAuthorization: "high",
        },
  );
}

function pipelineFor(
  review: ReturnType<typeof fakeGuardian>,
  options: { onToolCall?: () => void | Promise<void> } = {},
) {
  const actionReview = createToolActionReview({
    context: {
      actor: { platform: "local", userId: "local-user" },
      conversationId: CONVERSATION_ID,
      destination: DESTINATION,
      source: SOURCE,
      userIntent: () => "Look up the customers and post a summary to #team.",
    },
    onDecision: async () => undefined,
    onFatal: () => undefined,
    reviewer: { review },
  });
  return createToolPipeline({
    actionReview,
    catalogTools: {},
    conversationPrivacy: "private",
    onToolCall: options.onToolCall,
    sandbox: new SkillSandbox([], []),
    spanContext: {},
  });
}

function turnCount() {
  return createResumeState({
    checkpoint: { resumed: false, sliceId: 1 },
    conversationId: CONVERSATION_ID,
    destination: DESTINATION,
    durability: {},
    recordActiveMcpProviders: async () => undefined,
    runSource: SOURCE,
    startedAtMs: Date.now(),
    surface: "internal",
    turnId: "turn-codemode",
  });
}

/** A reviewed write that records each post it makes. */
function postTool(posts: Array<{ channel: string; text: string }>) {
  return tool({
    annotations: REVIEWED_ANNOTATIONS,
    approvalMode: "review",
    description: "Post a message to a channel.",
    inputSchema: Type.Object({ channel: Type.String(), text: Type.String() }),
    execute: async (input) => {
      posts.push(input);
      return { posted: true, channel: input.channel };
    },
  }) as AnyToolDefinition;
}

/** A tool that runs until the host aborts it. */
function waitTool(entered: () => void) {
  return tool({
    description: "Wait for a long job.",
    inputSchema: Type.Object({}),
    execute: async (_input, { signal }) => {
      entered();
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  }) as AnyToolDefinition;
}

describe("Code Mode bridge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reviews one drain as a batch and runs its calls in parallel", async () => {
    const review = fakeGuardian();
    const resume = turnCount();
    const allStarted = deferred();
    let started = 0;
    const lookup = tool({
      annotations: REVIEWED_ANNOTATIONS,
      approvalMode: "review",
      description: "Look up one customer.",
      inputSchema: Type.Object({ id: Type.String() }),
      execute: async ({ id }) => {
        started += 1;
        if (started === 3) {
          allStarted.resolve();
        }
        // Each call waits until all three run, so they must overlap.
        await allStarted.promise;
        return { id, healthy: true };
      },
    }) as AnyToolDefinition;

    const { result } = await runCodeModeScript({
      countToolCall: resume.countToolCall,
      pipeline: pipelineFor(review),
      source: `
        const customers = await Promise.all(
          ["a", "b", "c"].map((id) => tools.lookup({ id })),
        );
        return customers.map((customer) => customer.id);
      `,
      toolCallId: CODEMODE_CALL_ID,
      tools: { lookup },
    });

    expect(result).toEqual({
      ok: true,
      value: ["a", "b", "c"],
      output: "",
      truncated: false,
      calls: [1, 2, 3].map((n) => ({
        id: `${CODEMODE_CALL_ID}/c${n}`,
        toolName: "lookup",
        status: "ok",
      })),
    });
    expect(review).toHaveBeenCalledTimes(3);
    // The three nested calls count toward the Turn's tool-call total.
    expect(resume.countToolCall()).toBe(4);
  });

  it("lets a script run sequential tools at the same time", async () => {
    // `executionMode: "sequential"` orders direct calls only. In a script,
    // `Promise.all` overlaps the calls.
    const bothStarted = deferred();
    let started = 0;
    const edit = tool({
      description: "Edit a file in the Sandbox.",
      executionMode: "sequential",
      inputSchema: Type.Object({ path: Type.String() }),
      execute: async ({ path }) => {
        started += 1;
        if (started === 2) {
          bothStarted.resolve();
        }
        // Each call waits until both run, so they must overlap.
        await bothStarted.promise;
        return { path };
      },
    }) as AnyToolDefinition;

    const { result } = await runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(fakeGuardian()),
      source: `
        await Promise.all(["a", "b"].map((path) => tools.edit({ path })));
      `,
      toolCallId: CODEMODE_CALL_ID,
      tools: { edit },
    });

    expect(result.calls.map((call) => call.status)).toEqual(["ok", "ok"]);
  });

  it("refuses model-only tools inside the script", async () => {
    const handoff = vi.fn();
    const registry = createTools([], {}, {
      conversationId: CONVERSATION_ID,
      destination: DESTINATION,
      egress: {
        async fetch() {
          return new Response("ok");
        },
      },
      handoff: {
        activeProfile: { name: "standard" },
        profiles: [{ name: "handoff" }],
        execute: handoff,
      },
      source: SOURCE,
      workspace: {} as never,
    } as never);
    const { scriptTools } = planToolExposure(registry);

    const { result } = await runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(fakeGuardian()),
      source: `
        try {
          await tools.handoff({ profile: "handoff", reason: "harder task" });
        } catch (error) {
          return error.message;
        }
      `,
      toolCallId: CODEMODE_CALL_ID,
      tools: scriptTools,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toContain("tools.handoff does not exist.");
    expect(result.calls).toEqual([]);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("rejects only the denied call and keeps its marker", async () => {
    const review = fakeGuardian();
    const posts: Array<{ channel: string; text: string }> = [];

    const { result } = await runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(review),
      source: `
        const settled = await Promise.allSettled([
          tools.post({ channel: "#team", text: "summary" }),
          tools.post({ channel: "#public", text: "summary" }),
        ]);
        await tools.post({ channel: "#team", text: "done" });
        return settled.map((entry) => entry.status);
      `,
      toolCallId: CODEMODE_CALL_ID,
      tools: { post: postTool(posts) },
    });

    expect(result.value).toEqual(["fulfilled", "rejected"]);
    expect(posts).toEqual([
      { channel: "#team", text: "summary" },
      { channel: "#team", text: "done" },
    ]);
    expect(result.calls.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: `${CODEMODE_CALL_ID}/c1`, status: "ok" },
      { id: `${CODEMODE_CALL_ID}/c2`, status: "rejected" },
      { id: `${CODEMODE_CALL_ID}/c3`, status: "ok" },
    ]);
    const rejected = result.calls[1]!;
    expect(rejected.error).toContain(
      "Reason: Private data would go to a public channel.",
    );
    expect(rejected.guardianActionRejection).toMatchObject({
      decision: "deny",
      priorRejection: { input: { channel: "#public", text: "summary" } },
      version: 1,
    });
    // The third call came from a later drain, so Guardian saw the earlier
    // calls of the script with their status.
    expect(review.mock.calls[2]![0].script?.calls).toEqual([
      expect.objectContaining({ status: "completed", toolName: "post" }),
      expect.objectContaining({ status: "rejected", toolName: "post" }),
    ]);
  });

  it("refuses a drain over the batch limit before any review", async () => {
    const review = fakeGuardian();
    const onToolCall = vi.fn();
    const posts: Array<{ channel: string; text: string }> = [];

    const { result } = await runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(review, { onToolCall }),
      source: `
        const settled = await Promise.allSettled(
          Array.from({ length: 11 }, (_, n) =>
            tools.post({ channel: "#team", text: String(n) }),
          ),
        );
        return settled[0].reason.message;
      `,
      toolCallId: CODEMODE_CALL_ID,
      tools: { post: postTool(posts) },
    });

    expect(result.value).toContain("Too many tool calls at once (11)");
    expect(result.calls).toHaveLength(11);
    expect(new Set(result.calls.map((call) => call.status))).toEqual(
      new Set(["error"]),
    );
    expect(review).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it("asks the model to wrap up when a script reaches the turn limit", async () => {
    const resume = turnCount();
    // Earlier calls and the codemode call leave one call in the budget.
    for (let n = 1; n < botConfig.maxToolCallsPerTurn; n += 1) {
      resume.countToolCall();
    }
    let ran = 0;
    const check = tool({
      description: "Check something.",
      inputSchema: Type.Object({}),
      execute: async () => {
        ran += 1;
        return { checked: true };
      },
    }) as AnyToolDefinition;

    const { result } = await runCodeModeScript({
      countToolCall: resume.countToolCall,
      pipeline: pipelineFor(fakeGuardian()),
      source: `
        for (let n = 0; n < 3; n++) {
          await tools.check({}).catch(() => {});
        }
      `,
      toolCallId: CODEMODE_CALL_ID,
      tools: { check },
    });

    // Past the limit, a call gets the same wrap-up message as a blocked
    // direct call, not a terminal error.
    expect(ran).toBe(1);
    expect(result.calls).toEqual([
      { id: `${CODEMODE_CALL_ID}/c1`, toolName: "check", status: "ok" },
      ...[2, 3].map((n) => ({
        id: `${CODEMODE_CALL_ID}/c${n}`,
        toolName: "check",
        status: "error",
        error: TURN_LIMIT_WRAP_UP_MESSAGE,
      })),
    ]);
  });

  it("ends a script at the deadline and reports the call it cut off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = deferred();

    const run = runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(fakeGuardian()),
      source: `await tools.wait({});`,
      toolCallId: CODEMODE_CALL_ID,
      tools: { wait: waitTool(entered.resolve) },
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(CODE_MODE_SCRIPT_TIMEOUT_MS);
    const { result } = await run;

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
      calls: [{ id: `${CODEMODE_CALL_ID}/c1`, status: "interrupted" }],
    });
  });

  it("settles pending calls when the Run aborts", async () => {
    const controller = new AbortController();
    const firstEntered = deferred();
    const secondEntered = deferred();

    const run = runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(fakeGuardian()),
      signal: controller.signal,
      source: `await Promise.all([tools.first({}), tools.second({})]);`,
      toolCallId: CODEMODE_CALL_ID,
      tools: {
        first: waitTool(firstEntered.resolve),
        second: waitTool(secondEntered.resolve),
      },
    });
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    controller.abort(new Error("Run yielded"));
    const { result } = await run;

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "aborted", message: "Run yielded" },
      calls: [
        { toolName: "first", status: "interrupted" },
        { toolName: "second", status: "interrupted" },
      ],
    });
  });

  it("does not wait long for a call that ignores the abort before it runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const entered = deferred();
    const execute = vi.fn();
    // A hook before action review that never returns.
    const onToolCall = () => {
      entered.resolve();
      return new Promise<void>(() => undefined);
    };

    const run = runCodeModeScript({
      countToolCall: turnCount().countToolCall,
      pipeline: pipelineFor(fakeGuardian(), { onToolCall }),
      signal: controller.signal,
      source: `await tools.lookup({});`,
      toolCallId: CODEMODE_CALL_ID,
      tools: {
        lookup: tool({
          description: "Look up a record.",
          inputSchema: Type.Object({}),
          execute,
        }) as AnyToolDefinition,
      },
    });
    await entered.promise;
    controller.abort(new Error("Run yielded"));
    // Past the bridge's short settle grace, far below the script deadline.
    await vi.advanceTimersByTimeAsync(5_000);
    const { result } = await run;

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "aborted" },
      calls: [{ toolName: "lookup", status: "not_started" }],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
