import path from "node:path";
import { expect, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
} from "../../msw/handlers/eval-mcp-auth";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { type TestThread } from "../slack/harness";
import { createPluginAppFixture, type PluginAppFixture } from "../plugin-app";
import { piTextResponse, piToolCallResponse } from "../pi-stream";
import {
  makeTestReplyContext,
  type TestReplyRequestContext,
} from "../reply-context";

export const MCP_TOOL_NAME = "mcp__eval-auth__budget-echo";
export const SKILL_NAME = "eval-auth";
export const assistantReplyWithContext =
  "The budget deadline you mentioned earlier was Friday.";
export const priorBudgetContext = "You need the budget by Friday.";

const assistantReplyWithoutContext = "I need the earlier budget context first.";
const testThinkingSelection: TurnThinkingSelection = {
  thinkingLevel: "medium",
  reason: "test_default",
};
const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../plugins/eval-auth",
);

type ChatRuntimeModule = typeof import("../chat-runtime");
type McpAuthStoreModule = typeof import("@/chat/mcp/auth-store");
type McpOauthCallbackHarnessModule = typeof import("./oauth-callback-harness");
type RespondModule = typeof import("@/chat/respond");
type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

type McpAuthAgentProbe = {
  directProviderSearch: boolean;
  searchToolNames: string[][];
};

function extractTextContent(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .join("\n");
}

function hasPriorBudgetContext(messages: unknown[]): boolean {
  return messages.some((message) =>
    extractTextContent(message).includes(priorBudgetContext),
  );
}

function hasCompletedMcpAuthorization(messages: unknown[]): boolean {
  return messages.some((message) =>
    extractTextContent(message).includes(
      `MCP authorization completed for provider "${EVAL_MCP_AUTH_PROVIDER}"`,
    ),
  );
}

function extractSearchToolNames(messages: unknown[]): string[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }

    const candidate = message as {
      details?: unknown;
      role?: unknown;
      toolName?: unknown;
    };
    if (
      candidate.role !== "toolResult" ||
      candidate.toolName !== "searchMcpTools" ||
      !candidate.details ||
      typeof candidate.details !== "object"
    ) {
      continue;
    }

    const tools = (candidate.details as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools
      .map((tool) =>
        tool && typeof tool === "object"
          ? (tool as { tool_name?: unknown }).tool_name
          : undefined,
      )
      .filter((toolName): toolName is string => typeof toolName === "string");
  }

  return undefined;
}

function recordSearchToolNames(
  agentProbe: McpAuthAgentProbe,
  messages: unknown[],
): void {
  const toolNames = extractSearchToolNames(messages);
  if (!toolNames) {
    return;
  }

  const previous = agentProbe.searchToolNames.at(-1);
  if (previous && previous.join("\0") === toolNames.join("\0")) {
    return;
  }

  agentProbe.searchToolNames.push(toolNames);
}

function createAgentProbe(): McpAuthAgentProbe {
  return {
    directProviderSearch: false,
    searchToolNames: [],
  };
}

function createMcpAuthStreamFn(agentProbe: McpAuthAgentProbe): StreamFn {
  let initialPromptStarted = false;
  let resumeStep = 0;

  return async (_model, context) => {
    const messages = context.messages ?? [];
    const authorizationCompleted = hasCompletedMcpAuthorization(messages);

    if (authorizationCompleted && resumeStep > 0) {
      recordSearchToolNames(agentProbe, messages);
    }

    if (!initialPromptStarted) {
      initialPromptStarted = true;
      if (agentProbe.directProviderSearch) {
        return piToolCallResponse({
          id: "tool-search-provider",
          name: "searchMcpTools",
          parameters: {
            provider: EVAL_MCP_AUTH_PROVIDER,
            query: "budget echo query",
          },
        });
      }

      return piToolCallResponse({
        id: "tool-load-skill",
        name: "loadSkill",
        parameters: { skill_name: SKILL_NAME },
      });
    }

    if (!authorizationCompleted) {
      return piTextResponse("Authorization pending.");
    }

    if (resumeStep === 0) {
      resumeStep += 1;
      return piToolCallResponse({
        id: "tool-search-resume",
        name: "searchMcpTools",
        parameters: {
          provider: EVAL_MCP_AUTH_PROVIDER,
          query: "budget echo query",
        },
      });
    }

    if (resumeStep === 1) {
      resumeStep += 1;
      return piToolCallResponse({
        id: "tool-call-continue",
        name: "callMcpTool",
        parameters: {
          tool_name: MCP_TOOL_NAME,
          arguments: { query: "what did i say about the budget?" },
        },
      });
    }

    return piTextResponse(
      hasPriorBudgetContext(context.messages ?? [])
        ? assistantReplyWithContext
        : assistantReplyWithoutContext,
    );
  };
}

/** Starts the Slack runtime fixture for MCP auth parking and resume tests. */
export async function createMcpAuthRuntimeSlackFixture() {
  const agentProbe = createAgentProbe();
  resetSlackApiMockState();
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_BASE_URL: "https://junior.example.com",
    JUNIOR_STATE_ADAPTER: "memory",
    SLACK_BOT_TOKEN: "xoxb-test-token",
  };
  let pluginApp: PluginAppFixture | undefined = await createPluginAppFixture([
    EVAL_MCP_PLUGIN_ROOT,
  ]);

  vi.resetModules();
  const chatRuntime: ChatRuntimeModule = await import("../chat-runtime");
  const mcpAuthStore: McpAuthStoreModule =
    await import("@/chat/mcp/auth-store");
  const mcpOauthCallbackHarness: McpOauthCallbackHarnessModule =
    await import("./oauth-callback-harness");
  const respond: RespondModule = await import("@/chat/respond");
  const stateAdapter: StateAdapterModule = await import("@/chat/state/adapter");
  const threadState: ThreadStateModule =
    await import("@/chat/runtime/thread-state");
  const turnSessionStore: TurnSessionStoreModule =
    await import("@/chat/state/turn-session");

  await stateAdapter.disconnectStateAdapter();
  await stateAdapter.getStateAdapter().connect();

  return {
    agentProbe,
    chatRuntime,
    mcpAuthStore,
    stateAdapter,
    threadState,
    turnSessionStore,

    /** Creates a deterministic MCP-auth reply generator for this fixture. */
    createMcpAuthReplyGenerator(): ResumeReplyGenerator {
      const streamFn = createMcpAuthStreamFn(agentProbe);
      return (messageText: string, context: TestReplyRequestContext = {}) =>
        respond.generateAssistantReply(
          messageText,
          makeTestReplyContext({
            ...context,
            harness: {
              ...context.harness,
              streamFn,
              turnThinkingSelection: testThinkingSelection,
            },
          }),
        );
    },

    /** Mirrors fixture thread writes into the memory adapter used by callbacks. */
    async mirrorThreadStateToAdapter(thread: TestThread): Promise<void> {
      const originalSetState = thread.setState.bind(thread);
      thread.setState = async (next, options) => {
        await originalSetState(next, options);
        await stateAdapter
          .getStateAdapter()
          .set(`thread-state:${thread.id}`, thread.getState());
      };

      await stateAdapter
        .getStateAdapter()
        .set(`thread-state:${thread.id}`, thread.getState());
    },

    /** Completes the parked MCP OAuth flow through the callback route. */
    async runMcpOauthCallback(args: {
      state: string;
      generateReply: ResumeReplyGenerator;
    }) {
      return await mcpOauthCallbackHarness.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: args.state,
        code: EVAL_MCP_AUTH_CODE,
        generateReply: args.generateReply,
      });
    },

    /** Disconnects memory state, plugin fixtures, and test environment. */
    async cleanup() {
      await stateAdapter.disconnectStateAdapter();
      await pluginApp?.cleanup();
      pluginApp = undefined;
      process.env = { ...ORIGINAL_ENV };
    },
  };
}

/** Asserts Slack processing reaction add/remove lifecycles for a message. */
export function expectProcessingReactionLifecycles(args: {
  channel: string;
  completedCount?: number;
  count: number;
  timestamp: string;
}): void {
  const call = (name: string) =>
    expect.objectContaining({
      params: expect.objectContaining({
        channel: args.channel,
        timestamp: args.timestamp,
        name,
      }),
    });
  const eyes = Array.from({ length: args.count }, () => call("eyes"));
  const completed = Array.from({ length: args.completedCount ?? 0 }, () =>
    call("white_check_mark"),
  );

  expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
    ...eyes,
    ...completed,
  ]);
  expect(getCapturedSlackApiCalls("reactions.remove")).toEqual(eyes);
}

export { EVAL_MCP_AUTH_PROVIDER };
