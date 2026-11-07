import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb } from "@/chat/db";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { createTools } from "@/chat/tools";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";

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
  // Synonyms and abbreviations.
  ["fetch issue details", "github", "github_getIssue"],
  ["view a pull request", "github", "github_getPullRequest"],
  ["look up a repo", "github", "github_getRepository"],
  ["modify an issue", "github", "github_updateIssue"],
  ["file a bug", "github", "github_createIssue"],
  ["reply to an issue", "github", "github_commentOnIssue"],
  ["show my memories", "memory", "memory_listMemories"],
  ["unsubscribe from a resource", "resource-watches", "stopWatchingResources"],
] as const;

// Queries with no fitting tool in this catalog.
const NO_MATCH_CASES = [
  ["search code", "github"],
  ["book a flight", "github"],
] as const;

type AgentTools = ReturnType<typeof createPiAgentTools>;

function catalogTools(): AgentTools {
  return createPiAgentTools(
    createTools(
      [],
      {},
      {
        conversationId: CONVERSATION_ID,
        destination: { platform: "local", conversationId: CONVERSATION_ID },
        egress: {
          async fetch() {
            return new Response("ok");
          },
        },
        // Memory writes are registered only for public Conversations.
        source: createWebSource(CONVERSATION_ID, "public"),
        workspace: {} as Parameters<typeof createTools>[2]["workspace"],
      },
    ),
    new SkillSandbox([], []),
    {},
  );
}

async function search(
  tools: AgentTools,
  query: string,
  source: string | undefined,
): Promise<string[]> {
  const searchTools = tools.find(({ name }) => name === "searchTools");
  if (!searchTools) {
    throw new Error("searchTools was not registered");
  }
  const result = await searchTools.execute("tool-search", { query, source });
  return (result.details as { tools: Array<{ tool_name: string }> }).tools.map(
    ({ tool_name }) => tool_name,
  );
}

describe("tool search ranking", () => {
  let tools: AgentTools;

  beforeAll(async () => {
    await createApp({
      plugins: defineJuniorPlugins([githubPlugin(), memoryPlugin()]),
    });
    tools = catalogTools();
  });

  afterAll(async () => {
    await closeDb();
  });

  // Compare whole tables so one run shows every ranking regression.
  it("ranks the fitting tool first", async () => {
    const ranked = [];
    for (const [query, source] of RANKING_CASES) {
      const [top] = await search(tools, query, source);
      ranked.push([query, source, top]);
    }
    expect(ranked).toEqual(RANKING_CASES);
  });

  it("returns nothing when no tool fits", async () => {
    const found = [];
    for (const [query, source] of NO_MATCH_CASES) {
      found.push([query, await search(tools, query, source)]);
    }
    expect(found).toEqual(NO_MATCH_CASES.map(([query]) => [query, []]));
  });
});
