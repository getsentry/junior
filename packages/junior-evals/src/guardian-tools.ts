/**
 * The agent's tools for the Guardian evals.
 *
 * A case names a tool and gives its input. This module builds the `tool`
 * field from the same tool definitions that the agent gets, with the
 * production builder. So a case sends Guardian what production sends, and a
 * change to a tool changes the eval prompt too.
 */
import { createSlackSource } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { googlePlugin } from "@sentry/junior-google";
import { vercelPlugin } from "@sentry/junior-vercel";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { proposalTool, toolActionNeedsReview } from "@/chat/guardian/gate";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import type { ManagedMcpTool } from "@/chat/mcp/tool-manager";
import { createTools } from "@/chat/tool-support/create-tools";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";

/**
 * MCP tools come from the provider's server at run time. These are copies of
 * what the Linear and Notion servers return, as the MCP tool manager resolves
 * them.
 */
const MCP_TOOLS: ManagedMcpTool[] = [
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "[linear] Create or update a comment on a Linear issue. If id is omitted, create a new comment on the supplied issueId.",
    name: "mcp__linear__save_comment",
    rawName: "save_comment",
    parameters: {},
    provider: "linear",
    execute: unavailable,
  },
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "[linear] Create or update a Linear issue. If `id` is provided, updates the existing issue; otherwise creates a new one.",
    name: "mcp__linear__save_issue",
    rawName: "save_issue",
    parameters: {},
    provider: "linear",
    execute: unavailable,
  },
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "[notion] Update a Notion page's properties, content, icon, or cover.",
    name: "mcp__notion__notion-update-page",
    rawName: "notion-update-page",
    parameters: {},
    provider: "notion",
    execute: unavailable,
  },
];

async function unavailable(): Promise<never> {
  throw new Error("Guardian evals do not run tools.");
}

/** A public Slack thread, like the one of the evals' `slackContext()`. */
const context: ToolRuntimeContext = {
  conversationId: "slack:CGUARDIAN:1700000000.100000",
  conversationPrivacy: "public",
  destination: {
    platform: "slack",
    teamId: "TGUARDIAN",
    channelId: "CGUARDIAN",
  },
  source: createSlackSource({
    teamId: "TGUARDIAN",
    channelId: "CGUARDIAN",
    visibility: "public",
  }),
  location: {
    id: "location:TGUARDIAN:CGUARDIAN",
    provider: "slack",
    teamId: "TGUARDIAN",
    channelId: "CGUARDIAN",
    threadTs: "1700000000.100000",
  },
  egress: {
    async fetch() {
      return new Response("ok");
    },
  },
  // Guardian evals never run a tool, so no tool touches the sandbox or
  // storage. Storage and `createPreview` are set so the agent's attachment
  // and preview tools exist.
  attachmentStorage: {} as ToolRuntimeContext["attachmentStorage"],
  workspace: {
    ...({} as ToolRuntimeContext["workspace"]),
    createPreview: unavailable,
  },
  // A root Run can start and message child agents.
  messageAgent: unavailable,
  spawnAgent: unavailable,
  turnTools: turnBehavior({
    kind: "thread",
    hasParent: false,
    personInput: true,
  }).tools,
};

let agentTools: Promise<Record<string, AnyToolDefinition>> | undefined;

async function buildAgentTools(): Promise<Record<string, AnyToolDefinition>> {
  // The Google plugin registers its tools only when it is configured.
  process.env["GOOGLE_CLIENT_ID"] ??= "guardian-eval";
  process.env["GOOGLE_CLIENT_SECRET"] ??= "guardian-eval";
  process.env["GOOGLE_WORKSPACE_ACCOUNT_EMAIL"] ??= "junior@example.com";
  // createApp registers the plugins as a host does. It only reads the env
  // that the Guardian eval config already set, so the reviewer model stays
  // the same, and the database client it makes does not connect.
  await createApp({
    plugins: defineJuniorPlugins([
      githubPlugin(),
      googlePlugin(),
      vercelPlugin(),
    ]),
  });
  return {
    ...(createTools([], {}, context) as Record<string, AnyToolDefinition>),
    callMcpTool: createCallMcpToolTool({
      getResolvedActiveTools: () => MCP_TOOLS,
    }),
  };
}

/**
 * The `tool` field that production sends when the agent calls `name` with
 * `input`. MCP tools go through `callMcpTool`, as they do for the agent.
 */
export async function agentToolSpec(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolActionProposal["tool"]> {
  agentTools ??= buildAgentTools();
  const tool = (await agentTools)[name];
  if (!tool) {
    throw new Error(`The agent has no tool named ${name}.`);
  }
  let summary: string | undefined;
  try {
    summary = (await tool.describeCall?.(input))?.summary;
  } catch {
    // A GitHub pull request tool reads Junior's code records for its call
    // facts, and the evals have no database. Its proposal has no summary.
    summary = undefined;
  }
  return proposalTool(
    name,
    tool,
    await tool.resolveApprovalMetadata?.(input),
    summary,
  );
}

/**
 * Whether the gate sends this call to Guardian. A call that it does not
 * review runs. A tool that the agent does not have is reviewed.
 */
export async function gateReviews(
  tool: ToolActionProposal["tool"],
  input: Record<string, unknown>,
): Promise<boolean> {
  agentTools ??= buildAgentTools();
  const definition = (await agentTools)[tool.dispatcherName ?? tool.name];
  if (!definition) {
    return true;
  }
  return toolActionNeedsReview(
    definition,
    await definition.resolveApprovalMetadata?.(input),
  );
}
