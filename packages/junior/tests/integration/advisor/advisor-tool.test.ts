import { describe, expect, it } from "vitest";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import type { AdvisorConfig } from "@/chat/config";
import type { PiMessage } from "@/chat/pi/messages";
import { createTools } from "@/chat/tools";
import type { AdvisorSessionStore } from "@/chat/tools/advisor/session-store";
import {
  createAdvisorToolDefinitions,
  createAdvisorTool,
  type AdvisorToolResult,
  type AdvisorToolRuntimeContext,
} from "@/chat/tools/advisor/tool";
import { tool } from "@/chat/tools/definition";

type StreamResponse = Awaited<ReturnType<StreamFn>>;

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:advisor",
} as const;
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);

const config: AdvisorConfig = {
  modelId: "openai/gpt-5.5",
  thinkingLevel: "xhigh",
};

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function responseFor(message: ReturnType<typeof assistantMessage>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done" as const };
    },
    result: async () => message,
  } as unknown as StreamResponse;
}

function createMemoryAdvisorSessionStore(): AdvisorSessionStore & {
  getMessages: (conversationId: string) => PiMessage[] | undefined;
} {
  const sessions = new Map<string, PiMessage[]>();

  return {
    load: async (conversationId) =>
      structuredClone(sessions.get(conversationId) ?? []),
    save: async (conversationId, messages) => {
      sessions.set(conversationId, structuredClone(messages));
    },
    getMessages: (conversationId) => {
      const messages = sessions.get(conversationId);
      return messages ? structuredClone(messages) : undefined;
    },
  };
}

function runtimeContext(args: {
  advisorTools?: AgentTool[];
  config?: AdvisorConfig;
  conversationId?: string;
  store?: AdvisorSessionStore;
  streamFn: StreamFn;
}): AdvisorToolRuntimeContext {
  return {
    config: args.config ?? config,
    conversationId: args.conversationId ?? "slack:C123:1710000.0001",
    getTools: () => args.advisorTools ?? [],
    store: args.store ?? createMemoryAdvisorSessionStore(),
    streamFn: args.streamFn,
  };
}

async function executeAdvisor(
  toolDef: ReturnType<typeof createAdvisorTool>,
  input: { context: string; question: string },
): Promise<AdvisorToolResult> {
  if (!toolDef.execute) {
    throw new Error("advisor tool has no execute function");
  }
  return (await toolDef.execute(input, {})) as AdvisorToolResult;
}

describe("advisor tool", () => {
  it("is exposed only when advisor runtime context is enabled", () => {
    const baseContext = {
      destination: LOCAL_DESTINATION,
      egress: {
        async fetch() {
          return new Response("ok");
        },
      },
      source: LOCAL_SOURCE,
      sandbox: {} as any,
    };
    expect(createTools([], {}, baseContext)).not.toHaveProperty("advisor");

    const tools = createTools(
      [],
      {},
      {
        ...baseContext,
        advisor: runtimeContext({
          streamFn: async () => responseFor(assistantMessage("memo")),
        }),
      },
    );
    expect(tools).toHaveProperty("advisor");
  });

  it("sends the executor-curated context and advisor tools to the advisor", async () => {
    const contexts: unknown[] = [];
    const inspectEvidence = {
      name: "inspectEvidence",
      label: "inspectEvidence",
      description: "Inspect evidence for the advisor",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "inspected" }],
        details: { ok: true },
      }),
    } as AgentTool;
    const advisor = createAdvisorTool(
      runtimeContext({
        advisorTools: [inspectEvidence],
        streamFn: async (_model, context) => {
          contexts.push(context);
          return responseFor(assistantMessage("  Assessment\nUse a lock.\n"));
        },
      }),
    );

    const result = await executeAdvisor(advisor, {
      question: "What is the safest fix?",
      context:
        "Observed race: two workers update the same Slack thread state. Proposed fix: per-thread mutex.",
    });

    expect(result.details).toMatchObject({
      ok: true,
    });
    expect(result.content[0].text).toBe("  Assessment\nUse a lock.\n");
    expect(JSON.stringify(contexts[0])).toContain(
      "two workers update the same Slack thread state",
    );
    expect(JSON.stringify(contexts[0])).toContain("What is the safest fix?");
    expect(JSON.stringify(contexts[0])).toContain("inspectEvidence");
  });

  it("builds the advisor tool set from read-only metadata", () => {
    const readOnlyTool = tool({
      description: "Read only",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: Type.Object({}),
    });
    const conflictingTool = tool({
      description: "Conflicting",
      annotations: { readOnlyHint: true, destructiveHint: true },
      inputSchema: Type.Object({}),
    });
    const writeTool = tool({
      description: "Write",
      inputSchema: Type.Object({}),
    });

    const advisorDefinitions = createAdvisorToolDefinitions({
      conflictingTool,
      readFile: readOnlyTool,
      slackCanvasCreate: writeTool,
      slackCanvasRead: readOnlyTool,
      uploadArtifact: writeTool,
      writeFile: writeTool,
    });

    expect(Object.keys(advisorDefinitions).sort()).toEqual([
      "readFile",
      "slackCanvasRead",
    ]);
  });

  it("exposes the expected real read-only tool definitions to the advisor", () => {
    const advisorDefinitions = createAdvisorToolDefinitions(
      createTools(
        [],
        {},
        {
          destination: LOCAL_DESTINATION,
          egress: {
            async fetch() {
              return new Response("ok");
            },
          },
          source: LOCAL_SOURCE,
          sandbox: {} as any,
        },
      ),
    );

    expect(Object.keys(advisorDefinitions).sort()).toEqual([
      "findFiles",
      "grep",
      "listDir",
      "readFile",
      "systemTime",
      "webFetch",
      "webSearch",
    ]);
  });

  it("continues the advisor session across calls in a parent conversation", async () => {
    const contexts: Array<{ messages?: unknown[] }> = [];
    const store = createMemoryAdvisorSessionStore();
    const advisor = createAdvisorTool(
      runtimeContext({
        store,
        streamFn: async (_model, context) => {
          contexts.push(context);
          return responseFor(
            assistantMessage(`Assessment\nMemo ${contexts.length}`),
          );
        },
      }),
    );

    await executeAdvisor(advisor, {
      question: "Initial review",
      context: "First evidence packet.",
    });
    await executeAdvisor(advisor, {
      question: "Follow up",
      context: "Second evidence packet only.",
    });

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1].messages)).toContain(
      "Second evidence packet only",
    );
    expect(JSON.stringify(contexts[1].messages)).toContain("Memo 1");
    expect(
      store.getMessages("slack:C123:1710000.0001")?.length,
    ).toBeGreaterThan(0);
  });

  it("returns invalid_context without running advisor inference", async () => {
    let runs = 0;
    const advisor = createAdvisorTool(
      runtimeContext({
        streamFn: async () => {
          runs += 1;
          return responseFor(assistantMessage("unused"));
        },
      }),
    );

    const result = await executeAdvisor(advisor, {
      question: "Can you review this?",
      context: " ",
    });

    expect(runs).toBe(0);
    expect(result.details).toMatchObject({
      ok: false,
      error_code: "invalid_context",
    });
  });
});
