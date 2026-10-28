/**
 * Keeps `evals/guardian/tool-specs.json` equal to the `tool` field that
 * production sends to Guardian. It builds each spec from the real tool
 * definition with the production builder, `proposalTool`.
 *
 * After a change to one of these tools, run
 * `pnpm --filter @sentry/junior-evals test -u` and review the diff. A change
 * to the file runs the Guardian evals in CI.
 */
import { expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { googlePlugin } from "@sentry/junior-google";
import { vercelPlugin } from "@sentry/junior-vercel";
import { createApp, defineJuniorPlugins } from "@sentry/junior";
import { proposalTool } from "@/chat/guardian/gate";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import type { ManagedMcpTool } from "@/chat/mcp/tool-manager";
import { createTools } from "@/chat/tools";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Core and plugin tools that the Guardian evals review. */
const TOOL_NAMES = [
  "bash",
  "createEventAutomation",
  "deleteEventAutomation",
  "publishImage",
  "slackScheduleCreateAutomation",
  "slackScheduleUpdateAutomation",
  "updateEventAutomation",
  "github_cloneRepository",
  "github_createIssue",
  "github_createPullRequest",
  "github_resolvePullRequestReviewThread",
  "github_updateIssue",
  "github_updatePullRequest",
  "github_updatePullRequestFeedback",
  "google_createCalendarEvent",
  "google_findMeetingTimes",
  "vercel_deploymentCreate",
];

/**
 * MCP tools come from the provider's server at run time, so the repository
 * has no source for them. These are copies of what the server returned, as
 * the MCP tool manager resolves them.
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
];

async function unavailable(): Promise<never> {
  throw new Error("Guardian tool specs do not call MCP tools.");
}

/** The Slack thread of the Guardian evals' `slackContext()`. */
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
  // Building tool definitions never touches the sandbox.
  workspace: {} as ToolRuntimeContext["workspace"],
  // publishImage exists only with attachment storage.
  attachmentStorage: {
    provider: "guardian-eval",
    async put() {},
    async get() {
      return null;
    },
    async delete() {},
  },
};

async function buildToolSpecs(): Promise<
  Record<string, ToolActionProposal["tool"]>
> {
  // The Google plugin registers its tools only when it is configured.
  vi.stubEnv("GOOGLE_CLIENT_ID", "guardian-eval");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "guardian-eval");
  vi.stubEnv("GOOGLE_WORKSPACE_ACCOUNT_EMAIL", "junior@example.com");
  // createApp registers the plugins as a host does.
  await createApp({
    plugins: defineJuniorPlugins([
      githubPlugin(),
      googlePlugin(),
      vercelPlugin(),
    ]),
  });
  const tools = createTools([], {}, context);
  const specs: Record<string, ToolActionProposal["tool"]> = {};
  for (const name of TOOL_NAMES) {
    const tool = tools[name];
    if (!tool) {
      throw new Error(`Tool ${name} is not registered.`);
    }
    specs[name] = proposalTool(name, tool, undefined);
  }
  const callMcpTool = createCallMcpToolTool({
    getResolvedActiveTools: () => MCP_TOOLS,
  });
  for (const mcpTool of MCP_TOOLS) {
    specs[mcpTool.name] = proposalTool(
      "callMcpTool",
      callMcpTool,
      await callMcpTool.resolveApprovalMetadata?.({ tool_name: mcpTool.name }),
    );
  }
  return specs;
}

it("keeps the Guardian eval tool specs equal to production", async () => {
  const specs = await buildToolSpecs();
  await expect(`${JSON.stringify(specs, null, 2)}\n`).toMatchFileSnapshot(
    "../../evals/guardian/tool-specs.json",
  );
});
