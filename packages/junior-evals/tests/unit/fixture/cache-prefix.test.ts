import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { requestContextSummary } from "@/chat/agent/context-summary";
import { COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import {
  findCachePrefixBreaks,
  type AgentGatewayRequest,
} from "@junior-evals/fixture/cache-prefix";

const CACHE_MARKER = { cache_control: { type: "ephemeral" } };
const tools = [{ name: "systemTime", description: "Return the time." }];

function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function markedUser(text: string) {
  return { role: "user", content: [{ type: "text", text, ...CACHE_MARKER }] };
}

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function request(
  messages: AgentGatewayRequest["messages"],
  overrides: Partial<AgentGatewayRequest> = {},
): AgentGatewayRequest {
  return {
    model: "anthropic/claude",
    system: [{ type: "text", text: "System.", ...CACHE_MARKER }],
    tools,
    messages,
    sessionAffinity: "conversation-1",
    ...overrides,
  };
}

/** The text that compaction appends to ask for a summary. */
async function summaryRequestText(): Promise<string> {
  let context: Context | undefined;
  const capture: Parameters<typeof requestContextSummary>[1] = async (
    _model,
    requestContext,
  ) => {
    context = requestContext;
    throw new Error("captured");
  };
  await requestContextSummary(
    {
      model: {} as never,
      context: { systemPrompt: "System.", messages: [] },
      options: {},
    },
    capture,
  ).catch(() => undefined);
  const part = context?.messages.at(-1)?.content;
  if (!Array.isArray(part) || part[0]?.type !== "text") {
    throw new Error("No summary request text");
  }
  return part[0].text;
}

const first = request([markedUser("first")]);
const second = request([user("first"), assistant("one"), markedUser("again")]);

describe("findCachePrefixBreaks", () => {
  it("accepts requests that extend the previous one while cache markers move", () => {
    expect(findCachePrefixBreaks([first, second])).toEqual([]);
  });

  it.each<[string, AgentGatewayRequest]>([
    [
      "tools",
      request(second.messages, {
        tools: [{ name: "systemTime", description: "Return the time now." }],
      }),
    ],
    [
      "system",
      request(second.messages, { system: [{ type: "text", text: "Now." }] }),
    ],
    ["messages", request([user("FIRST"), assistant("one"), user("again")])],
  ])("reports a changed %s prefix", (part, changed) => {
    expect(findCachePrefixBreaks([first, changed])).toEqual([
      { request: 1, part, detail: expect.any(String) },
    ]);
  });

  it("accepts a conversation-mode Turn after an Automation run", () => {
    const run = request(first.messages, {
      system: [{ type: "text", text: "Automation run." }],
      tools: [...tools, { name: "finishAutomationRun" }],
    });
    expect(findCachePrefixBreaks([run, second])).toEqual([]);
  });

  it("compares requests only within their Conversation", () => {
    const other = request([user("other")], {
      sessionAffinity: "conversation-2",
    });
    expect(findCachePrefixBreaks([first, other, second])).toEqual([]);
  });

  it("accepts compaction summary requests and the history that a summary replaces", async () => {
    const summaryRequest = request([
      ...first.messages,
      user(await summaryRequestText()),
    ]);
    const compacted = request([user(`${COMPACTION_SUMMARY_PREFIX} Done.`)]);
    expect(
      findCachePrefixBreaks([first, summaryRequest, second, compacted]),
    ).toEqual([]);
  });
});
