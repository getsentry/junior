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

describe("searchTools", () => {
  it("discovers catalog tools from metadata and returns call details", async () => {
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
      tools: [
        {
          tool_name: "agentDemo_lookupCustomer",
          description: "Lookup customer health for account review.",
          exposure: "deferred",
          source: "agent-demo",
          input_schema_summary: "customerId (required)",
          call_notes: [
            "Use for renewal risk triage before drafting an account plan.",
            "Pass the customer identifier exactly as provided by the user.",
          ],
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
          input_schema_summary: "command (required)",
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
