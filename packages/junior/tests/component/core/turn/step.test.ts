import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelSettings } from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
import { runStep, type StepInput } from "@/core/turn/step";
import {
  createAssistantMessage,
  fakeModelClient,
} from "../../../fixtures/model-stream";

const user: Message = { role: "user", content: "hi", timestamp: 0 };

function tool(
  name: string,
  options: Pick<ToolDefinition, "replay" | "execute">,
): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    parameters: { type: "object", properties: {} },
    ...options,
  };
}

const MODEL: ModelSettings = {
  id: "test-model",
  reasoning: "none",
  privacy: "private",
};

/** A step whose model request is the history, with no new messages. */
function stepInput(
  overrides: Partial<StepInput<string>> & Pick<StepInput<string>, "history">,
): StepInput<string> {
  return {
    request: () =>
      Promise.resolve({
        systemPrompt: "You are Junior.",
        messages: overrides.history,
        model: MODEL,
        newMessages: [],
      }),
    tools: [],
    client: fakeModelClient([]),
    session: "conversation-1",
    replay: false,
    skipDanglingToolCalls: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function replyWithCalls(...names: string[]): AssistantMessage {
  return createAssistantMessage({
    type: "toolCalls",
    calls: names.map((name) => ({ name, arguments: {}, id: `call-${name}` })),
  });
}

describe("runStep", () => {
  it("completes the Turn with a text reply and sends only tool declarations", async () => {
    const requests: Context[] = [];
    const reply = createAssistantMessage({ type: "text", text: "hello" });
    const lookup = tool("lookup", {
      replay: "safe",
      execute: () => Promise.resolve({ content: [] }),
    });

    const { result } = await runStep(
      stepInput({
        history: [user],
        tools: [lookup],
        client: fakeModelClient([
          {
            type: "message",
            message: reply,
            onRequest: (context) => {
              requests.push(context);
            },
          },
        ]),
      }),
    );

    expect(result).toEqual({ outcome: "completed", messages: [reply] });
    expect(requests[0]?.tools).toEqual([
      {
        name: "lookup",
        description: "The lookup tool.",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("runs a tool call in the next step and continues with its result", async () => {
    const reply = replyWithCalls("lookup");
    const lookup = tool("lookup", {
      replay: "safe",
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: "found it" }],
          details: { hits: 1 },
        }),
    });

    const { result: modelStep } = await runStep(
      stepInput({
        history: [user],
        tools: [lookup],
        client: fakeModelClient([{ type: "message", message: reply }]),
      }),
    );
    const { result: toolStep } = await runStep(
      stepInput({ history: [user, reply], tools: [lookup] }),
    );

    expect(modelStep).toEqual({ outcome: "continue", messages: [reply] });
    expect(toolStep).toMatchObject({
      outcome: "continue",
      messages: [
        {
          role: "toolResult",
          toolCallId: "call-lookup",
          content: [{ type: "text", text: "found it" }],
          details: { hits: 1 },
          isError: false,
        },
      ],
    });
  });

  it("builds the model request only for a model step, and returns its new messages", async () => {
    const reply = replyWithCalls("lookup");
    const lookup = tool("lookup", {
      replay: "safe",
      execute: () => Promise.resolve({ content: [] }),
    });
    const note: Message = { role: "user", content: "a note", timestamp: 0 };
    const requests: Context[] = [];
    let built = 0;
    const request = () => {
      built += 1;
      return Promise.resolve({
        systemPrompt: "You are Junior.",
        messages: [user, note],
        model: MODEL,
        newMessages: ["note"],
      });
    };

    const modelStep = await runStep(
      stepInput({
        history: [user],
        request,
        client: fakeModelClient([
          {
            type: "message",
            message: reply,
            onRequest: (context) => {
              requests.push(context);
            },
          },
        ]),
      }),
    );
    const toolStep = await runStep(
      stepInput({ history: [user, reply], tools: [lookup], request }),
    );

    expect(built).toBe(1);
    expect(requests[0]?.messages).toEqual([user, note]);
    expect(modelStep.newMessages).toEqual(["note"]);
    expect(toolStep).toMatchObject({
      result: { outcome: "continue" },
      newMessages: [],
    });
  });

  it("gives the model an error result for a tool that throws, is unknown, or gets invalid arguments", async () => {
    const ran: string[] = [];
    const broken = tool("broken", {
      replay: "safe",
      execute: () => Promise.reject(new Error("upstream is down")),
    });
    const search: ToolDefinition = {
      ...tool("search", {
        replay: "safe",
        execute: () => {
          ran.push("search");
          return Promise.resolve({ content: [] });
        },
      }),
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };

    const { result } = await runStep(
      stepInput({
        history: [user, replyWithCalls("broken", "missing", "search")],
        tools: [broken, search],
      }),
    );

    expect(ran).toEqual([]);
    expect(result).toMatchObject({
      outcome: "continue",
      messages: [
        {
          toolCallId: "call-broken",
          content: [{ type: "text", text: "upstream is down" }],
          isError: true,
        },
        {
          toolCallId: "call-missing",
          content: [{ type: "text", text: "Tool missing not found" }],
          isError: true,
        },
        { toolCallId: "call-search", isError: true },
      ],
    });
  });

  it("runs the calls of a batch at the same time", async () => {
    let running = 0;
    let mostRunning = 0;
    const execute = async () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await Promise.resolve();
      running -= 1;
      return { content: [] };
    };

    await runStep(
      stepInput({
        history: [user, replyWithCalls("first", "second")],
        tools: [
          tool("first", { replay: "safe", execute }),
          tool("second", { replay: "safe", execute }),
        ],
      }),
    );

    expect(mostRunning).toBe(2);
  });

  it("ends the Turn only when every call in the batch ends it", async () => {
    const signIn = tool("sign_in", {
      replay: "safe",
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: "Sign-in link sent." }],
          endsTurn: true,
        }),
    });
    const lookup = tool("lookup", {
      replay: "safe",
      execute: () => Promise.resolve({ content: [] }),
    });

    const { result: alone } = await runStep(
      stepInput({
        history: [user, replyWithCalls("sign_in")],
        tools: [signIn],
      }),
    );
    const { result: mixed } = await runStep(
      stepInput({
        history: [user, replyWithCalls("sign_in", "lookup")],
        tools: [signIn, lookup],
      }),
    );

    expect(alone.outcome).toBe("completed");
    expect(mixed.outcome).toBe("continue");
  });

  it("runs only safe calls again on replay, and only calls with no result", async () => {
    const ran: string[] = [];
    const record = (name: string) => () => {
      ran.push(name);
      return Promise.resolve({ content: [] });
    };
    const tools = [
      tool("read", { replay: "safe", execute: record("read") }),
      tool("send", { replay: "never", execute: record("send") }),
      tool("done", { replay: "never", execute: record("done") }),
    ];
    const saved: Message = {
      role: "toolResult",
      toolCallId: "call-done",
      toolName: "done",
      content: [],
      isError: false,
      timestamp: 0,
    };

    const { result } = await runStep(
      stepInput({
        history: [user, replyWithCalls("read", "send", "done"), saved],
        tools,
        replay: true,
      }),
    );

    expect(ran).toEqual(["read"]);
    expect(result).toMatchObject({
      outcome: "continue",
      messages: [
        { toolCallId: "call-read", isError: false },
        { toolCallId: "call-send", isError: true },
      ],
    });
  });

  it("does not run calls or keep text from a reply that hit the output token limit", async () => {
    const ran: string[] = [];
    const send = tool("send", {
      replay: "safe",
      execute: () => {
        ran.push("send");
        return Promise.resolve({ content: [] });
      },
    });
    const cutOffCalls = createAssistantMessage({
      type: "toolCalls",
      calls: [{ name: "send", arguments: {}, id: "call-send" }],
      stopReason: "length",
    });
    const cutOffText = createAssistantMessage({
      type: "text",
      text: "Here is the first half",
      stopReason: "length",
    });

    const { result: toolStep } = await runStep(
      stepInput({ history: [user, cutOffCalls], tools: [send] }),
    );
    const { result: modelStep } = await runStep(
      stepInput({
        history: [user],
        client: fakeModelClient([{ type: "message", message: cutOffText }]),
      }),
    );

    expect(ran).toEqual([]);
    expect(toolStep).toMatchObject({
      outcome: "continue",
      messages: [{ toolCallId: "call-send", isError: true }],
    });
    expect(modelStep).toEqual({
      outcome: "failed",
      reply: cutOffText,
      failure: {
        kind: "cut_off_output",
        retryable: false,
        message: "The reply hit the output token limit",
      },
    });
  });

  it("fails the step with the failed reply when the model request fails", async () => {
    const failure = createAssistantMessage({
      type: "error",
      errorMessage: "overloaded",
    });
    const { result } = await runStep(
      stepInput({
        history: [user],
        client: fakeModelClient([{ type: "message", message: failure }]),
      }),
    );

    expect(result).toEqual({
      outcome: "failed",
      reply: failure,
      failure: { kind: "unknown", retryable: false, message: "overloaded" },
    });
  });

  it("throws instead of returning results when the step is aborted", async () => {
    const stopped = new Error("lease lost");
    const duringModel = new AbortController();
    const duringTools = new AbortController();
    const slow = tool("slow", {
      replay: "safe",
      execute: () => {
        duringTools.abort(stopped);
        return Promise.reject(new Error("aborted"));
      },
    });

    const modelStep = runStep(
      stepInput({
        history: [user],
        signal: duringModel.signal,
        client: fakeModelClient([
          {
            type: "error",
            errorMessage: "Request was aborted",
            stopReason: "aborted",
            onRequest: () => duringModel.abort(stopped),
          },
        ]),
      }),
    );
    const toolStep = runStep(
      stepInput({
        history: [user, replyWithCalls("slow")],
        tools: [slow],
        signal: duringTools.signal,
      }),
    );

    await expect(modelStep).rejects.toBe(stopped);
    await expect(toolStep).rejects.toBe(stopped);
  });

  it("runs the tool hooks in order: beforeCall, beforeBatch, the calls, afterCall", async () => {
    const order: string[] = [];
    const record = (name: string): ToolDefinition =>
      tool(name, {
        replay: "safe",
        execute: () => {
          order.push(`run ${name}`);
          return Promise.resolve({ content: [{ type: "text", text: name }] });
        },
      });
    const stop = (text: string) => ({
      content: [{ type: "text" as const, text }],
      isError: true,
    });

    const { result } = await runStep(
      stepInput({
        history: [
          user,
          replyWithCalls("blocked", "lookup", "send", "missing", "denied"),
        ],
        tools: [
          record("blocked"),
          record("lookup"),
          record("send"),
          record("denied"),
        ],
        hooks: {
          beforeCall: (call) => {
            order.push(`beforeCall ${call.name}`);
            return Promise.resolve(
              call.name === "blocked" ? stop("Blocked.") : undefined,
            );
          },
          beforeBatch: (calls) => {
            order.push(
              `beforeBatch ${calls.map((call) => call.name).join(",")}`,
            );
            return Promise.resolve(new Map([["call-denied", stop("Denied.")]]));
          },
          afterCall: (call, callResult) => {
            order.push(`afterCall ${call.name}`);
            return Promise.resolve(
              call.name === "lookup"
                ? { content: [{ type: "text", text: "lookup, checked" }] }
                : callResult,
            );
          },
        },
      }),
    );

    // A call with no tool fails core's checks, so only afterCall sees it.
    expect(order.slice(0, 5).sort()).toEqual(
      [
        "beforeCall blocked",
        "beforeCall denied",
        "beforeCall lookup",
        "beforeCall send",
        "beforeBatch lookup,send,denied",
      ].sort(),
    );
    expect(order[4]).toBe("beforeBatch lookup,send,denied");
    // Each call's afterCall follows its own run, so calls can interleave.
    expect(order.slice(5).sort()).toEqual([
      "afterCall blocked",
      "afterCall denied",
      "afterCall lookup",
      "afterCall missing",
      "afterCall send",
      "run lookup",
      "run send",
    ]);
    for (const name of ["lookup", "send"]) {
      expect(order.indexOf(`run ${name}`)).toBeLessThan(
        order.indexOf(`afterCall ${name}`),
      );
    }
    expect(result).toMatchObject({
      outcome: "continue",
      messages: [
        {
          toolCallId: "call-blocked",
          isError: true,
          content: [{ text: "Blocked." }],
        },
        {
          toolCallId: "call-lookup",
          isError: false,
          content: [{ text: "lookup, checked" }],
        },
        { toolCallId: "call-send", isError: false },
        { toolCallId: "call-missing", isError: true },
        {
          toolCallId: "call-denied",
          isError: true,
          content: [{ text: "Denied." }],
        },
      ],
    });
  });

  it("fails the step when a tool hook throws, and runs no call when a before hook throws", async () => {
    const executed: string[] = [];
    const send = tool("send", {
      replay: "never",
      execute: () => {
        executed.push("send");
        return Promise.resolve({ content: [] });
      },
    });
    const failing = new Error("Hook failed");
    const steps = [
      { beforeCall: () => Promise.reject(failing) },
      { beforeBatch: () => Promise.reject(failing) },
      { afterCall: () => Promise.reject(failing) },
    ].map((hooks) =>
      runStep(
        stepInput({
          history: [user, replyWithCalls("send")],
          tools: [send],
          hooks,
        }),
      ),
    );

    for (const step of steps) {
      await expect(step).rejects.toBe(failing);
    }
    // Only the afterCall step ran the call.
    expect(executed).toEqual(["send"]);
  });

  it("reaches no later hook or tool when the Turn stops during a before hook", async () => {
    const reached: string[] = [];
    const send = tool("send", {
      replay: "never",
      execute: () => {
        reached.push("send");
        return Promise.resolve({ content: [] });
      },
    });
    const stopped = new Error("stopped");
    const stopDuring = (hook: "beforeCall" | "beforeBatch") => {
      const controller = new AbortController();
      const stop = () => controller.abort(stopped);
      return runStep(
        stepInput({
          history: [user, replyWithCalls("send")],
          tools: [send],
          signal: controller.signal,
          hooks: {
            beforeCall: () => {
              if (hook === "beforeCall") stop();
              return Promise.resolve(undefined);
            },
            beforeBatch: () => {
              reached.push("beforeBatch");
              if (hook === "beforeBatch") stop();
              return Promise.resolve(new Map());
            },
          },
        }),
      );
    };

    await expect(stopDuring("beforeCall")).rejects.toBe(stopped);
    expect(reached).toEqual([]);
    await expect(stopDuring("beforeBatch")).rejects.toBe(stopped);
    expect(reached).toEqual(["beforeBatch"]);
  });
});
