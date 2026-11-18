import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@/core/tool";
import { runStep, type StepInput } from "@/core/turn/step";

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

function stepInput(
  overrides: Partial<StepInput> & Pick<StepInput, "messages">,
): StepInput {
  return {
    systemPrompt: "You are Junior.",
    tools: [],
    complete: () => Promise.reject(new Error("no model request expected")),
    replay: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function replyWithCalls(...names: string[]): AssistantMessage {
  return fauxAssistantMessage(
    names.map((name) => fauxToolCall(name, {}, { id: `call-${name}` })),
    { stopReason: "toolUse" },
  );
}

describe("runStep", () => {
  it("completes the Turn with a text reply and sends only tool declarations", async () => {
    const requests: Context[] = [];
    const reply = fauxAssistantMessage("hello");
    const lookup = tool("lookup", {
      replay: "safe",
      execute: () => Promise.resolve({ content: [] }),
    });

    const result = await runStep(
      stepInput({
        messages: [user],
        tools: [lookup],
        complete: (context) => {
          requests.push(context);
          return Promise.resolve(reply);
        },
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

    const modelStep = await runStep(
      stepInput({
        messages: [user],
        tools: [lookup],
        complete: () => Promise.resolve(reply),
      }),
    );
    const toolStep = await runStep(
      stepInput({ messages: [user, reply], tools: [lookup] }),
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

  it("gives the model an error result when a tool throws", async () => {
    const broken = tool("broken", {
      replay: "safe",
      execute: () => Promise.reject(new Error("upstream is down")),
    });

    const result = await runStep(
      stepInput({
        messages: [user, replyWithCalls("broken")],
        tools: [broken],
      }),
    );

    expect(result).toMatchObject({
      outcome: "continue",
      messages: [
        {
          toolCallId: "call-broken",
          content: [{ type: "text", text: "upstream is down" }],
          isError: true,
        },
      ],
    });
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

    const alone = await runStep(
      stepInput({
        messages: [user, replyWithCalls("sign_in")],
        tools: [signIn],
      }),
    );
    const mixed = await runStep(
      stepInput({
        messages: [user, replyWithCalls("sign_in", "lookup")],
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
      tool("send", { replay: "unsafe", execute: record("send") }),
      tool("done", { replay: "unsafe", execute: record("done") }),
    ];
    const saved: Message = {
      role: "toolResult",
      toolCallId: "call-done",
      toolName: "done",
      content: [],
      isError: false,
      timestamp: 0,
    };

    const result = await runStep(
      stepInput({
        messages: [user, replyWithCalls("read", "send", "done"), saved],
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

  it("fails the Turn when the model request fails", async () => {
    const result = await runStep(
      stepInput({
        messages: [user],
        complete: () =>
          Promise.resolve(
            fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "overloaded",
            }),
          ),
      }),
    );

    expect(result).toEqual({ outcome: "failed", error: "overloaded" });
  });
});
