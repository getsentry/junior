import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import type { AdvisorConfig } from "@/chat/config";
import { createTools } from "@/chat/tools";
import { getAgentStepStore, getConversationStore, getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import type { AgentStepStore } from "@/chat/conversations/history";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  advisorChildConversationId,
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
const PARENT_CONVERSATION_ID = "slack:C123:1710000.0001";

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

async function sqlStores(): Promise<{
  stepStore: AgentStepStore;
  conversationStore: ConversationStore;
}> {
  return {
    stepStore: getAgentStepStore(),
    conversationStore: getConversationStore(),
  };
}

function runtimeContext(args: {
  advisorTools?: AgentTool[];
  config?: AdvisorConfig;
  conversationId?: string;
  conversationStore?: ConversationStore;
  streamFn: StreamFn;
}): AdvisorToolRuntimeContext {
  return {
    config: args.config ?? config,
    conversationId: args.conversationId ?? PARENT_CONVERSATION_ID,
    getTools: () => args.advisorTools ?? [],
    ...(args.conversationStore
      ? { conversationStore: args.conversationStore }
      : {}),
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
  it("is exposed only when advisor runtime context is enabled", async () => {
    const { conversationStore } = await sqlStores();
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
          conversationStore,
          streamFn: async () => responseFor(assistantMessage("memo")),
        }),
      },
    );
    expect(tools).toHaveProperty("advisor");
  });

  it("sends the executor-curated context and advisor tools to the advisor", async () => {
    const { conversationStore } = await sqlStores();
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
        conversationStore,
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

    expect(result).toMatchObject({
      ok: true,
    });
    expect(result.memo).toBe("  Assessment\nUse a lock.\n");
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

  it("persists advisor history as a child conversation with parent subagent steps", async () => {
    const { stepStore, conversationStore } = await sqlStores();
    const childConversationId = advisorChildConversationId(
      PARENT_CONVERSATION_ID,
    );
    const contexts: Array<{ messages?: unknown[] }> = [];
    const advisor = createAdvisorTool(
      runtimeContext({
        conversationStore,
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

    // The child conversation row is linked to its parent.
    const childRows = await getDb()
      .select({
        conversationId: juniorConversations.conversationId,
        parentConversationId: juniorConversations.parentConversationId,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, childConversationId));
    expect(childRows).toEqual([
      {
        conversationId: childConversationId,
        parentConversationId: PARENT_CONVERSATION_ID,
      },
    ]);

    // The parent records subagent lifecycle steps; the child stores Pi history.
    const parentTypes = (
      await stepStore.loadHistory(PARENT_CONVERSATION_ID)
    ).map((step) => step.entry.type);
    expect(parentTypes).toEqual(["subagent_started", "subagent_ended"]);
    const childCountAfterFirst = (
      await stepStore.loadHistory(childConversationId)
    ).filter((step) => step.entry.type === "pi_message").length;
    expect(childCountAfterFirst).toBeGreaterThan(0);

    // A second call continues the same child history and appends to it.
    await executeAdvisor(advisor, {
      question: "Follow up",
      context: "Second evidence packet only.",
    });
    expect(JSON.stringify(contexts[1]?.messages)).toContain(
      "Second evidence packet only",
    );
    expect(JSON.stringify(contexts[1]?.messages)).toContain("Memo 1");

    const childRowsAfter = await getDb()
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, childConversationId));
    expect(childRowsAfter).toHaveLength(1);

    const childCountAfterSecond = (
      await stepStore.loadHistory(childConversationId)
    ).filter((step) => step.entry.type === "pi_message").length;
    expect(childCountAfterSecond).toBeGreaterThan(childCountAfterFirst);

    const parentTypesAfter = (
      await stepStore.loadHistory(PARENT_CONVERSATION_ID)
    ).map((step) => step.entry.type);
    expect(parentTypesAfter).toEqual([
      "subagent_started",
      "subagent_ended",
      "subagent_started",
      "subagent_ended",
    ]);
  });

  it("returns invalid_context without running advisor inference", async () => {
    const { conversationStore } = await sqlStores();
    let runs = 0;
    const advisor = createAdvisorTool(
      runtimeContext({
        conversationStore,
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
    expect(result).toMatchObject({
      ok: false,
      error_code: "invalid_context",
    });
  });
});
