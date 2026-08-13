import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  createSearchToolsTool,
  summarizeModelVisibleDescription,
} from "@/chat/tools/search-tools";
import { tool } from "@/chat/tools/definition";

function catalog() {
  return {
    bash: tool({
      description: "Run a shell command.",
      inputSchema: Type.Object(
        {
          command: Type.String({
            minLength: 1,
            description: "Command to execute.",
          }),
        },
        { additionalProperties: false },
      ),
    }),
    agentDemo_lookupCustomer: tool({
      description:
        "Lookup customer health for account review.\n\nSecond paragraph with extra implementation detail.",
      promptSnippet:
        "Use for renewal risk triage before drafting an account plan.",
      promptGuidelines: [
        "Pass the customer identifier exactly as provided by the user.",
      ],
      identity: {
        id: "agent-demo.lookupCustomer",
        name: "lookupCustomer",
        plugin: "agent-demo",
      },
      source: {
        id: "agent-demo",
        description:
          "Agent demo tools for customer health and account planning.\n\nInternal registration details should not be rendered.",
      },
      exposure: "deferred",
      inputSchema: Type.Object(
        {
          customerId: Type.String({
            minLength: 1,
            description: "Customer identifier to inspect.",
          }),
        },
        { additionalProperties: false },
      ),
    }),
    memory_createMemory: tool({
      description: "Create long-term memory records for explicit requests.",
      identity: {
        id: "memory.createMemory",
        name: "createMemory",
        plugin: "memory",
      },
      source: {
        id: "memory",
        description: "Long-term Junior memory storage and recall",
      },
      exposure: "deferred",
      inputSchema: Type.Object(
        {
          candidate: Type.String({
            minLength: 1,
            description: "Memory candidate to store.",
          }),
        },
        { additionalProperties: false },
      ),
    }),
  };
}

function mixedCatalog() {
  const githubSource = {
    id: "github",
    description:
      "GitHub deployment, issue, pull request, release, and repository workflows via GitHub App",
  };
  const linearSource = {
    id: "linear",
    description: "Linear issue tracking via hosted MCP server",
  };
  const memorySource = {
    id: "memory",
    description: "Long-term Junior memory storage and recall",
  };
  const notionSource = {
    id: "notion",
    description: "Notion page search and summarization",
  };
  return {
    github_cloneRepository: tool({
      description:
        "Clone a GitHub repository into the sandbox workspace. The destination must not already exist.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        repo: Type.String({
          description: 'Repository in "owner/name" format.',
        }),
        directory: Type.Optional(
          Type.String({ description: "Destination directory." }),
        ),
      }),
    }),
    github_createIssue: tool({
      description: "Create a GitHub issue with a conversation footer.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        repo: Type.String(),
        title: Type.String({ description: "Issue title." }),
      }),
    }),
    github_createPullRequest: tool({
      description: "Create a GitHub pull request with a conversation footer.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        repo: Type.String(),
        title: Type.String({ description: "Pull request title." }),
      }),
    }),
    github_getPullRequest: tool({
      description:
        "Get a GitHub pull request and its current details for inspection.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        repo: Type.String(),
        number: Type.Integer({ description: "Pull request number." }),
      }),
    }),
    github_getRepository: tool({
      description: "Get a GitHub repository and its metadata.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({ repo: Type.String() }),
    }),
    github_updateIssue: tool({
      description: "Update an existing GitHub issue's title, body, or state.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        repo: Type.String(),
        number: Type.Integer({ description: "Issue number." }),
      }),
    }),
    github_updatePullRequest: tool({
      description:
        "Update an existing GitHub pull request's title, body, base branch, or state.",
      source: githubSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        repo: Type.String(),
        number: Type.Integer({ description: "Pull request number." }),
      }),
    }),
    mcp__linear__create_issue: tool({
      description: "Create a new Linear issue.",
      source: linearSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        title: Type.String({ description: "Issue title." }),
        team: Type.String({ description: "Team name or ID." }),
      }),
    }),
    mcp__linear__create_issue_label: tool({
      description: "Create a new Linear issue label.",
      source: linearSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        name: Type.String({ description: "Label name." }),
      }),
    }),
    mcp__linear__get_issue: tool({
      description: "Retrieve detailed information about a Linear issue by ID.",
      source: linearSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        id: Type.String({ description: "Issue ID or identifier." }),
      }),
    }),
    memory_createMemory: tool({
      description: "Store an explicit long-term memory.",
      source: memorySource,
      exposure: "deferred",
      inputSchema: Type.Object({
        content: Type.String({ description: "Memory content." }),
      }),
    }),
    memory_searchMemories: tool({
      description: "Search active memories visible in the current context.",
      source: memorySource,
      exposure: "deferred",
      inputSchema: Type.Object({
        query: Type.String({ description: "Targeted memory recall query." }),
      }),
    }),
    "mcp__notion__notion-fetch": tool({
      description:
        "Retrieve a Notion page, database, or data source by URL or ID.",
      source: notionSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        id: Type.String({ description: "Notion entity URL or ID." }),
      }),
    }),
    "mcp__notion__notion-search": tool({
      description: "Search the Notion workspace and connected sources.",
      source: notionSource,
      exposure: "deferred",
      inputSchema: Type.Object({
        query: Type.String({ description: "Semantic workspace search query." }),
      }),
    }),
    systemTime: tool({
      description:
        "Return current system time. Do not use for historical or timezone-conversion requests.",
      inputSchema: Type.Object({}),
    }),
  };
}

describe("searchTools", () => {
  it("discovers catalog tools from metadata and returns their schemas", async () => {
    const searchTools = createSearchToolsTool(catalog());

    expect(searchTools.description).toContain(
      "Deferred tools are grouped by source",
    );
    expect(searchTools.description).toContain(
      "- memory: Long-term Junior memory storage and recall",
    );
    expect(searchTools.description).not.toContain("memory_createMemory");

    const result = await searchTools.execute!(
      { query: "renewal risk", max_results: 1 },
      {},
    );

    expect(result).toMatchObject({
      query: "renewal risk",
      source: null,
      sources: [
        {
          id: "agent-demo",
          description:
            "Agent demo tools for customer health and account planning.",
        },
      ],
      total_catalog_tools: 3,
      total_matches: 1,
      returned_tools: 1,
      execution_tool: "executeTool",
      tools: [
        {
          tool_name: "agentDemo_lookupCustomer",
          description: "Lookup customer health for account review.",
          exposure: "deferred",
          source: "agent-demo",
          input_schema: {
            properties: {
              customerId: {
                type: "string",
                description: "Customer identifier to inspect.",
              },
            },
          },
          call_notes: [
            "Use for renewal risk triage before drafting an account plan.",
            "Pass the customer identifier exactly as provided by the user.",
          ],
        },
      ],
    });
    expect(result).not.toHaveProperty("data");

    const privateTraceResult = searchTools.privateTraceResult?.(result);
    expect(privateTraceResult).toEqual({
      tools: [
        {
          tool_name: "agentDemo_lookupCustomer",
          description: "Lookup customer health for account review.",
          input_schema: result.tools[0]?.input_schema,
        },
      ],
    });

    const directResult = await searchTools.execute!({ query: "shell" }, {});
    expect(directResult).toMatchObject({
      returned_tools: 1,
      sources: [],
      tools: [
        {
          tool_name: "bash",
          exposure: "direct",
          input_schema: {
            required: ["command"],
            properties: {
              command: {
                description: "Command to execute.",
                minLength: 1,
                type: "string",
              },
            },
          },
        },
      ],
    });
    expect(directResult.tools[0]).not.toHaveProperty("source");
  });

  it("filters by source and omits per-tool source in filtered results", async () => {
    const searchTools = createSearchToolsTool(catalog());

    const result = await searchTools.execute!(
      { source: "memory", query: "long-term" },
      {},
    );

    expect(result).toMatchObject({
      source: "memory",
      sources: [
        {
          id: "memory",
          description: "Long-term Junior memory storage and recall",
        },
      ],
      total_eligible_tools: 1,
      total_matches: 1,
      returned_tools: 1,
      tools: [
        {
          tool_name: "memory_createMemory",
          description: "Create long-term memory records for explicit requests.",
        },
      ],
    });
    expect(result.tools[0]).not.toHaveProperty("source");

    const noMatchResult = await searchTools.execute!(
      { source: "memory", query: "customer" },
      {},
    );

    expect(noMatchResult).toMatchObject({
      source: "memory",
      sources: [
        {
          id: "memory",
          description: "Long-term Junior memory storage and recall",
        },
      ],
      total_eligible_tools: 1,
      total_matches: 0,
      returned_tools: 0,
      tools: [],
    });
  });

  it("ranks production search variations by relevant catalog metadata", async () => {
    const searchTools = createSearchToolsTool(mixedCatalog());
    const cases = [
      ["clone repository", "github_cloneRepository", "github"],
      ["repository clone", "github_cloneRepository", "github"],
      ["clone repository sandbox", "github_cloneRepository", "github"],
      [
        "clone repository inspect source code commits",
        "github_cloneRepository",
        "github",
      ],
      [
        "clone repository inspect GitHub source code pull requests commits",
        "github_cloneRepository",
        "github",
      ],
      [
        "clone repository list code contents",
        "github_cloneRepository",
        undefined,
      ],
      ["search code repository", "github_getRepository", "github"],
      ["create issue", "github_createIssue", "github"],
      ["create issue", "mcp__linear__create_issue", "linear"],
      ["update GitHub issue", "github_updateIssue", "github"],
      ["create pull request", "github_createPullRequest", "github"],
      ["GitHub create pull request", "github_createPullRequest", "github"],
      ["update pull request", "github_updatePullRequest", "github"],
    ] as const;

    for (const [query, expectedTool, source] of cases) {
      const result = await searchTools.execute!(
        { query, source, max_results: 1 },
        {},
      );

      expect({
        query,
        tools: result.tools.map(({ tool_name }) => tool_name),
      }).toEqual({ query, tools: [expectedTool] });
    }
  });

  it("returns related candidates for broad production queries", async () => {
    const searchTools = createSearchToolsTool(mixedCatalog());
    const cases = [
      [
        "pull request checks details diff comments",
        "github_getPullRequest",
        "github",
      ],
      [
        "search pull requests commits code github",
        "github_getPullRequest",
        "github",
      ],
      ["issue", "mcp__linear__get_issue", "linear"],
    ] as const;

    for (const [query, expectedTool, source] of cases) {
      const result = await searchTools.execute!(
        { query, source, max_results: 20 },
        {},
      );

      expect({
        query,
        tools: result.tools.map(({ tool_name }) => tool_name),
      }).toEqual({ query, tools: expect.arrayContaining([expectedTool]) });
    }
  });

  it("does not match partial words or unrelated production queries", async () => {
    const searchTools = createSearchToolsTool(mixedCatalog());

    for (const [query, source] of [
      ["version", undefined],
      ["waterdog", "memory"],
    ] as const) {
      const result = await searchTools.execute!(
        { query, source, max_results: 20 },
        {},
      );

      expect({ query, result }).toMatchObject({
        query,
        result: {
          total_matches: 0,
          returned_tools: 0,
          tools: [],
        },
      });
    }
  });

  it("lists provider tools when a production search omits its query", async () => {
    const searchTools = createSearchToolsTool(mixedCatalog());

    const result = await searchTools.execute!(
      { source: "notion", max_results: 20 },
      {},
    );

    expect(result).toMatchObject({
      query: null,
      source: "notion",
      total_eligible_tools: 2,
      total_matches: 2,
      returned_tools: 2,
      tools: [
        { tool_name: "mcp__notion__notion-fetch" },
        { tool_name: "mcp__notion__notion-search" },
      ],
    });
  });

  it("returns known sources without throwing for an unknown source", async () => {
    const searchTools = createSearchToolsTool(catalog());

    const result = await searchTools.execute!(
      { source: "missing", query: "memory" },
      {},
    );

    expect(result).toMatchObject({
      source: "missing",
      sources: [{ id: "agent-demo" }, { id: "memory" }],
      total_eligible_tools: 0,
      total_matches: 0,
      returned_tools: 0,
      tools: [],
    });
  });

  it("bounds empty all-source search while listing known sources", async () => {
    const searchTools = createSearchToolsTool(catalog());

    const result = await searchTools.execute!(
      { query: "", max_results: 1 },
      {},
    );

    expect(result).toMatchObject({
      query: "",
      source: null,
      sources: [
        {
          id: "agent-demo",
          description:
            "Agent demo tools for customer health and account planning.",
        },
        {
          id: "memory",
          description: "Long-term Junior memory storage and recall",
        },
      ],
      total_eligible_tools: 3,
      total_matches: 3,
      returned_tools: 1,
    });
    expect(result.tools).toHaveLength(1);
  });

  it("returns compact source ids for mixed-source results", async () => {
    const searchTools = createSearchToolsTool(catalog());

    const result = await searchTools.execute!(
      { query: "", max_results: 3 },
      {},
    );

    expect(result).toMatchObject({
      source: null,
      sources: [
        {
          id: "agent-demo",
          description:
            "Agent demo tools for customer health and account planning.",
        },
        {
          id: "memory",
          description: "Long-term Junior memory storage and recall",
        },
      ],
      returned_tools: 3,
      tools: [
        {
          tool_name: "agentDemo_lookupCustomer",
          source: "agent-demo",
        },
        {
          tool_name: "bash",
        },
        {
          tool_name: "memory_createMemory",
          source: "memory",
        },
      ],
    });
    expect(result.tools[0]?.source).toBe("agent-demo");
    expect(result.tools[2]?.source).toBe("memory");
    expect(result.tools[1]).not.toHaveProperty("source");
  });

  it("summarizes model-visible descriptions", () => {
    expect(
      summarizeModelVisibleDescription(
        `  First paragraph with\nextra spacing.  \n\nSecond paragraph.`,
      ),
    ).toBe("First paragraph with extra spacing.");

    expect(summarizeModelVisibleDescription("x".repeat(220))).toHaveLength(180);
    expect(summarizeModelVisibleDescription("x".repeat(220))).toMatch(
      /\.\.\.$/,
    );
  });
});
