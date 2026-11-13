import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWebSource,
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb } from "@/chat/db";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { pluginToolsHook } from "../../fixtures/plugin-tools";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { searchCatalogTools } from "@/chat/tools/search-tools";
import { planToolExposure } from "@/chat/tool-exposure";

const rootTurnTools = turnBehavior({
  kind: "root",
  personInput: true,
}).tools;

const CONVERSATION_ID = "local:test:tool-search-ranking";

// Each query has a tool that fits it in this catalog.
const RANKING_CASES = [
  [
    "clone a GitHub repository into the sandbox",
    "github",
    "github_cloneRepository",
  ],
  ["change the pull request title", "github", "github_updatePullRequest"],
  [
    "change the base branch of a pull request",
    "github",
    "github_updatePullRequest",
  ],
  ["closing a pull request", "github", "github_updatePullRequest"],
  [
    "mark a draft pull request ready for review",
    "github",
    "github_updatePullRequest",
  ],
  ["create a new GitHub issue", "github", "github_createIssue"],
  ["get issue details", "github", "github_getIssue"],
  ["edit the issue title", "github", "github_updateIssue"],
  ["closing an issue", "github", "github_updateIssue"],
  ["add a comment to an issue", "github", "github_commentOnIssue"],
  ["edit my issue comment", "github", "github_updateIssueComment"],
  ["react to an issue", "github", "github_reactToIssue"],
  ["get CI check status for a commit", "github", "github_getStatus"],
  ["get the latest release", "github", "github_getRelease"],
  ["get repository details", "github", "github_getRepository"],
  ["get deployment status", "github", "github_getDeployment"],
  ["remember something", "memory", "memory_createMemory"],
  ["forget a memory", "memory", "memory_archiveMemory"],
  ["list my memories", "memory", "memory_listMemories"],
  [
    "find messages in conversation history",
    "conversations",
    "searchConversationEvents",
  ],
  ["read one conversation event", "conversations", "readConversationEvent"],
  ["list active watches", "resource-watches", "listWatches"],
  ["stop watching a resource", "resource-watches", "stopWatchingResources"],
  ["find open review items", "review-desk", "searchReviewItems"],
  ["update a review item", "review-desk", "updateReviewItem"],
  ["list automations", "automations", "searchAutomations"],
  // Synonyms and abbreviations.
  ["fetch issue details", "github", "github_getIssue"],
  ["view a pull request", "github", "github_getPullRequest"],
  // The tool name has both the action and the object.
  ["get pull request diff", "github", "github_getPullRequest"],
  ["look up a repo", "github", "github_getRepository"],
  ["modify an issue", "github", "github_updateIssue"],
  ["add an issue", "github", "github_createIssue"],
  ["reply to an issue", "github", "github_commentOnIssue"],
  ["show my memories", "memory", "memory_listMemories"],
  ["unsubscribe from a resource", "resource-watches", "stopWatchingResources"],
  // A second plugin with the same kind of tools, named in snake_case.
  ["create an issue", "tracker", "tracker_create_issue"],
  ["get issue details", "tracker", "tracker_get_issue"],
  ["add a comment to an issue", "tracker", "tracker_comment_on_issue"],
  ["reply to an issue", "tracker", "tracker_comment_on_issue"],
  ["create an issue", "github", "github_createIssue"],
  // Without a source, a provider name in the query picks the tool.
  ["create a Tracker issue", null, "tracker_create_issue"],
  ["create a GitHub issue", null, "github_createIssue"],
  ["comment on a Tracker issue", null, "tracker_comment_on_issue"],
] as const;

// Queries with no fitting tool in this catalog.
const NO_MATCH_CASES = [
  ["search code", "github"],
  ["book a flight", "github"],
  // One tool has the action and another has the object.
  ["create repository", "github"],
  ["create repository", null],
  // Memory tools can create and archive, not edit.
  ["edit a memory", null],
] as const;

// Queries with two actions. The top two tools are the ones that do them.
const TWO_ACTION_CASES = [
  [
    "automation list update channel",
    "automations",
    ["searchAutomations", "updateAutomation"],
  ],
  [
    "list then update automation destination",
    "automations",
    ["searchAutomations", "updateAutomation"],
  ],
] as const;

// Word matches that cannot tell which tool fits, so the model decides.
const MODEL_DECIDES_CASES = [
  ["closing a pull request", "github"],
  ["mark a draft pull request ready for review", "github"],
  ["closing an issue", "github"],
  ["add a comment to an issue", "github"],
  // Issue and issue comment tools share the update action.
  ["edit my issue comment", "github"],
  ["remember something", "memory"],
  ["modify an issue", "github"],
  ["create repository", "github"],
  ["create repository", null],
  ["edit a memory", null],
] as const;

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

// An issue tracker plugin whose tools overlap GitHub's issue tools.
const trackerPlugin = defineJuniorPlugin({
  manifest: {
    name: "tracker",
    displayName: "Tracker",
    description: "Issue tracking for project work",
  },
  hooks: {
    tools: pluginToolsHook(() => ({
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
    })),
  },
});

type AgentTools = ReturnType<typeof createPiAgentTools>;

function catalogToolDefinitions() {
  return createTools(
    [],
    {},
    {
      turnTools: rootTurnTools,
      conversationId: CONVERSATION_ID,
      destination: { platform: "local", conversationId: CONVERSATION_ID },
      egress: {
        async fetch() {
          return new Response("ok");
        },
      },
      source: createWebSource(CONVERSATION_ID, "public"),
      workspace: {} as Parameters<typeof createTools>[2]["workspace"],
    },
  ) as Record<string, AnyToolDefinition>;
}

function catalogTools(): AgentTools {
  return createPiAgentTools(
    catalogToolDefinitions(),
    new SkillSandbox([], []),
    { spanContext: {}, searchToolsCost: { owner: "none" } },
  );
}

async function search(
  tools: AgentTools,
  query: string,
  source: string | null,
): Promise<{ names: string[]; note?: string }> {
  const searchTools = tools.find(({ name }) => name === "searchTools");
  if (!searchTools) {
    throw new Error("searchTools was not registered");
  }
  const result = await searchTools.execute("tool-search", { query, source });
  const { tools: found, note } = result.details as {
    tools: Array<{ tool_name: string }>;
    note?: string;
  };
  return { names: found.map(({ tool_name }) => tool_name), note };
}

describe("tool search ranking", () => {
  let tools: AgentTools;
  let catalog: Record<string, AnyToolDefinition>;

  beforeAll(async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        githubPlugin(),
        memoryPlugin(),
        trackerPlugin,
      ]),
    });
    tools = catalogTools();
    catalog = planToolExposure(catalogToolDefinitions()).catalogTools;
  });

  afterAll(async () => {
    await closeDb();
  });

  // Compare whole tables so one run shows every ranking regression.
  it("ranks the fitting tool first", () => {
    const ranked = RANKING_CASES.map(([query, source]) => [
      query,
      source,
      searchCatalogTools(catalog, query, source).matches[0],
    ]);
    expect(ranked).toEqual(RANKING_CASES);
  });

  it("ranks a tool for each action in a two-action query", () => {
    const found = TWO_ACTION_CASES.map(([query, source]) => [
      query,
      source,
      searchCatalogTools(catalog, query, source).matches.slice(0, 2).sort(),
    ]);
    expect(found).toEqual(TWO_ACTION_CASES);
  });

  it("sends only unclear word matches to the model", () => {
    const reranked = [...RANKING_CASES, ...NO_MATCH_CASES].flatMap(
      ([query, source, tool]) => {
        const { unclearCandidates } = searchCatalogTools(
          catalog,
          query,
          source,
        );
        if (unclearCandidates.length === 0) return [];
        // The model can pick only a candidate, so the fitting tool must be
        // one.
        return [[query, source, !tool || unclearCandidates.includes(tool)]];
      },
    );
    expect(reranked).toEqual(
      MODEL_DECIDES_CASES.map(([query, source]) => [query, source, true]),
    );
  });

  it("returns nothing when no tool fits", async () => {
    const found = NO_MATCH_CASES.map(([query, source]) => [
      query,
      searchCatalogTools(catalog, query, source).matches,
    ]);
    expect(found).toEqual(NO_MATCH_CASES.map(([query]) => [query, []]));
    // A query that matches no tool words gets the note without the model.
    expect(await search(tools, "book a flight", "github")).toEqual({
      names: [],
      note: expect.stringContaining("No tool fits"),
    });
  });

  it("skips the model when one tool clearly wins", async () => {
    // The test has no model, so a model call would fail the search.
    const { names } = await search(
      tools,
      "create a new GitHub issue",
      "github",
    );
    expect(names[0]).toBe("github_createIssue");
  });
});
