/**
 * Isolated harness for `searchTools` ranking with model rerank.
 *
 * Runs the real `searchTools` tool over the GitHub and memory plugins plus a
 * small issue tracker plugin whose tools overlap GitHub's. Unclear word
 * matches call the configured fast model. It does not run the agent, Slack,
 * Postgres, or Redis.
 */
import {
  createWebSource,
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import * as z from "zod";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";

const CONVERSATION_ID = "local:eval:tool-search";

interface ToolSearchEvalInput {
  query: string;
  source: string | null;
  /** The tool that must rank first, or null when no tool fits. */
  expected: string | null;
}

interface ToolSearchEvalOutput extends Record<string, JsonValue> {
  expected: string | null;
  found: string[];
}

function trackerTool(description: string, inputSchema: z.ZodTypeAny) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description,
    inputSchema,
    outputSchema: pluginToolOutputSchema,
    async execute() {
      return {};
    },
  });
}

const issueKey = z.string().describe("Issue key, such as ENG-123.");

// MCP-style snake_case names, like an issue tracker server exposes.
const trackerPlugin = defineJuniorPlugin({
  manifest: {
    name: "tracker",
    displayName: "Tracker",
    description: "Issue tracking for project work",
  },
  hooks: {
    tools: () => ({
      create_issue: trackerTool(
        "Create an issue in a Tracker project.",
        z.object({
          project: z.string().describe("Project key."),
          title: z.string().describe("Issue title."),
        }),
      ),
      get_issue: trackerTool(
        "Get one Tracker issue by key.",
        z.object({ key: issueKey }),
      ),
      comment_on_issue: trackerTool(
        "Add a comment to a Tracker issue.",
        z.object({
          key: issueKey,
          body: z.string().describe("Comment text."),
        }),
      ),
    }),
  },
});

type AgentTools = ReturnType<typeof createPiAgentTools>;

let agentTools: Promise<AgentTools> | undefined;

async function buildAgentTools(): Promise<AgentTools> {
  // createApp registers the plugins as a host does. The database client it
  // makes does not connect.
  await createApp({
    plugins: defineJuniorPlugins([
      githubPlugin(),
      memoryPlugin(),
      trackerPlugin,
    ]),
  });
  return createPiAgentTools(
    createTools(
      [],
      {},
      {
        turnTools: turnBehavior({ kind: "root", personInput: true }).tools,
        conversationId: CONVERSATION_ID,
        destination: { platform: "local", conversationId: CONVERSATION_ID },
        egress: {
          async fetch() {
            return new Response("ok");
          },
        },
        source: createWebSource(CONVERSATION_ID, "public"),
        // Search never runs a tool, so no tool touches the sandbox.
        workspace: {} as Parameters<typeof createTools>[2]["workspace"],
      },
    ),
    new SkillSandbox([], []),
    {},
  );
}

async function search(query: string, source: string | null) {
  agentTools ??= buildAgentTools();
  const searchTools = (await agentTools).find(
    ({ name }) => name === "searchTools",
  );
  if (!searchTools) {
    throw new Error("searchTools was not registered");
  }
  const result = await searchTools.execute("tool-search-eval", {
    query,
    source,
  });
  const { tools } = result.details as { tools: Array<{ tool_name: string }> };
  return tools.map(({ tool_name }) => tool_name);
}

/** Lightweight vitest-evals harness for exact tool search cases. */
export const toolSearchHarness = createHarness<
  ToolSearchEvalInput,
  ToolSearchEvalOutput
>({
  name: "tool-search",
  run: async ({ input }) => {
    const found = await search(input.query, input.source);
    const ok =
      input.expected === null
        ? found.length === 0
        : found[0] === input.expected;
    if (!ok) {
      throw new Error(
        `Search found [${found.join(", ")}]; expected ${input.expected ?? "none"} first`,
      );
    }
    return {
      output: { expected: input.expected, found },
      events: [
        {
          type: "message",
          role: "user",
          content: `${input.query} (source: ${input.source ?? "any"})`,
        },
        {
          type: "message",
          role: "assistant",
          content: `Found: ${found.join(", ") || "none"}`,
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: botConfig.fastModelId,
      },
    };
  },
});

/** Shared vitest-evals suite options for exact tool search evals. */
export const toolSearchEvals = {
  harness: toolSearchHarness,
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  ToolSearchEvalInput,
  ToolSearchEvalOutput,
  typeof toolSearchHarness
>;
