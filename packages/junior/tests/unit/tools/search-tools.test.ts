import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createSearchToolsTool } from "@/chat/tools/search-tools";
import { tool } from "@/chat/tools/definition";

describe("searchTools", () => {
  it("discovers catalog tools from metadata and returns call details", async () => {
    const searchTools = createSearchToolsTool({
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
        description: "Lookup customer health for account review.",
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
    });

    const result = await searchTools.execute!(
      { query: "renewal risk", max_results: 1 },
      {},
    );

    expect(result).toMatchObject({
      query: "renewal risk",
      total_catalog_tools: 2,
      returned_tools: 1,
      tools: [
        {
          tool_name: "agentDemo_lookupCustomer",
          description: "Lookup customer health for account review.",
          exposure: "deferred",
          source: {
            type: "plugin",
            id: "agent-demo.lookupCustomer",
            name: "lookupCustomer",
            plugin: "agent-demo",
          },
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
      tools: [
        {
          tool_name: "bash",
          exposure: "direct",
          source: { type: "core" },
          input_schema_summary: "command (required)",
        },
      ],
    });
  });
});
