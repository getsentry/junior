import { afterEach, describe, expect, it, vi } from "vitest";
import { createResumeState } from "@/chat/agent/resume";
import { runCodeModeScript } from "@/chat/codemode/bridge";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
import { createToolActionReview } from "@/chat/guardian/gate";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { planToolExposure } from "@/chat/tool-exposure";
import { createToolPipeline } from "@/chat/tool-support/pi-tool-adapter";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const CURRENT_CONVERSATION_ID = "slack:C123:1700000000.100000";
const CODEMODE_CALL_ID = "call-codemode";
const SOURCE = { kind: "scheduled_automation" } as const;

function context(): ToolRuntimeContext {
  return {
    conversationId: CURRENT_CONVERSATION_ID,
    destination: { platform: "slack", teamId: "T123", channelId: "C123" },
    location: {
      id: "location:T123:C123",
      provider: "slack",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.100000",
    },
    source: SOURCE,
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

/** Run a Code Mode script against the tools a real turn exposes to scripts. */
async function runScript(source: string) {
  const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
    decision: "allow",
    reason: "Read-only lookup.",
    riskLevel: "low",
    rule: "none",
    userAuthorization: "high",
  }));
  const actionReview = createToolActionReview({
    context: {
      actor: { platform: "slack", teamId: "T123", userId: "U123" },
      conversationId: CURRENT_CONVERSATION_ID,
      destination: context().destination,
      source: SOURCE,
      userIntent: () => "What was the checksum in the earlier deploy log?",
    },
    onDecision: async () => undefined,
    onFatal: () => undefined,
    reviewer: { review },
  });
  const resume = createResumeState({
    checkpoint: { resumed: false, sliceId: 1 },
    conversationId: CURRENT_CONVERSATION_ID,
    destination: context().destination,
    durability: {},
    recordActiveMcpProviders: async () => undefined,
    runSource: SOURCE,
    startedAtMs: Date.now(),
    surface: "internal",
    turnId: "turn-read-event",
  });
  const { scriptTools } = planToolExposure(createTools([], {}, context()));
  const { result } = await runCodeModeScript({
    countToolCall: resume.countToolCall,
    pipeline: createToolPipeline({
      actionReview,
      catalogTools: {},
      conversationPrivacy: "public",
      sandbox: new SkillSandbox([], []),
      spanContext: {},
    }),
    source,
    toolCallId: CODEMODE_CALL_ID,
    tools: scriptTools,
  });
  return result;
}

async function recordSlackConversation(args: {
  channelId: string;
  conversationId: string;
  visibility: "private" | "public";
}) {
  await getConversationStore().recordActivity({
    conversationId: args.conversationId,
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: args.channelId,
    },
    nowMs: 1,
    source: "slack",
    visibility: args.visibility,
  });
}

describe("readConversationEvent", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("reads a large tool result from a replaced history version in pages", async () => {
    await recordSlackConversation({
      channelId: "C123",
      conversationId: CURRENT_CONVERSATION_ID,
      visibility: "public",
    });
    const log = Array.from(
      { length: 1_500 },
      (_, index) => `step ${index} checksum ${(index * 7_919).toString(16)}`,
    ).join("\n");
    const events = getConversationEventStore();
    const [toolResult] = await events.append(CURRENT_CONVERSATION_ID, [
      {
        createdAtMs: 1,
        data: {
          type: "tool_result",
          toolCallId: "call-bash",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: log }],
          timestamp: 1,
        },
      },
    ]);
    await events.replaceHistory(CURRENT_CONVERSATION_ID, {
      createdAtMs: 2,
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "test/model",
        summary: "Ran a deploy.",
        replacementHistory: [],
      },
    });
    expect(
      await events.loadCurrentHistoryVersion(CURRENT_CONVERSATION_ID),
    ).toBe(toolResult!.historyVersion + 1);

    const result = await runScript(`
      const pages = [];
      let offset = 0;
      while (true) {
        const page = await tools.readConversationEvent({
          seq: ${toolResult!.seq},
          offset,
          limit: 15000,
        });
        pages.push(page);
        if (!page.has_more) break;
        offset += page.text.length;
      }
      return {
        first: { ...pages[0], text: undefined },
        pageCount: pages.length,
        text: pages.map((page) => page.text).join(""),
      };
    `);

    expect(result.ok).toBe(true);
    const value = result.value as {
      first: Record<string, unknown>;
      pageCount: number;
      text: string;
    };
    expect(value.text).toBe(log);
    expect(value.pageCount).toBe(Math.ceil(log.length / 15_000));
    expect(value.first).toMatchObject({
      conversation_id: CURRENT_CONVERSATION_ID,
      seq: toolResult!.seq,
      history_version: toolResult!.historyVersion,
      type: "tool_result",
      tool_name: "bash",
      is_error: false,
      offset: 0,
      total_chars: log.length,
      has_more: true,
    });

    const missing = await runScript(`
      try {
        await tools.readConversationEvent({ seq: 999 });
      } catch (error) {
        return error.message;
      }
    `);
    expect(missing.value).toContain(
      `Conversation event not found: seq 999 in ${CURRENT_CONVERSATION_ID}`,
    );
  });

  it("refuses events of a private conversation outside the current tree", async () => {
    await recordSlackConversation({
      channelId: "C123",
      conversationId: CURRENT_CONVERSATION_ID,
      visibility: "public",
    });
    const privateConversationId = "slack:D999:1700000000.300000";
    await recordSlackConversation({
      channelId: "D999",
      conversationId: privateConversationId,
      visibility: "private",
    });
    const [message] = await getConversationEventStore().append(
      privateConversationId,
      [
        {
          createdAtMs: 1,
          data: {
            type: "message",
            messageId: "m-1",
            role: "user",
            text: "private text",
          },
        },
      ],
    );

    const result = await runScript(`
      try {
        return await tools.readConversationEvent({
          conversation_id: ${JSON.stringify(privateConversationId)},
          seq: ${message!.seq},
        });
      } catch (error) {
        return error.message;
      }
    `);

    expect(result.value).toContain(
      `Conversation events are not accessible: ${privateConversationId}`,
    );
    expect(JSON.stringify(result)).not.toContain("private text");
  });
});
