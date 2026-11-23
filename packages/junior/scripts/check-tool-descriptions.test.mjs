import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectToolDescriptionIssues,
  diffBaseline,
  MAX_PARAM_DESCRIPTION_CHARS,
  MAX_TOOL_DESCRIPTION_CHARS,
  namesParam,
  parseBaseline,
} from "./check-tool-descriptions.mjs";

describe("check-tool-descriptions", () => {
  it("accepts a short description that leaves fields to describe()", () => {
    const issues = collectToolDescriptionIssues({
      "src/tool.ts": `
        zodTool({
          description: "Search messages and return matches.",
          inputSchema: z.object({
            query: z.string().describe("Search text."),
            channel_id: z.string().optional().describe("Channel to search."),
          }),
        });
      `,
    });

    assert.deepEqual(issues, []);
  });

  it("flags field names, also in nested and imported schemas", () => {
    const issues = collectToolDescriptionIssues(
      {
        "src/fields.ts": `
          export const fieldSchema = z.object({
            kind: z.enum(["text"]).describe("Field kind."),
          });
        `,
        "src/tool.ts": `
          import { fieldSchema } from "@/fields";
          zodTool({
            description: "Add an item. Set \`kind\` on each field and pass dedupe_key to update.",
            inputSchema: z.object({
              dedupe_key: z.string().describe("Stable key."),
              fields: z.array(fieldSchema).describe("Fields to ask."),
            }),
          });
        `,
      },
      { app: "src" },
    );

    assert.deepEqual(issues, [
      "src/tool.ts\ttool-description-names-param\tdedupe_key: Add an item. Set `kind` on each field and pass d…",
      "src/tool.ts\ttool-description-names-param\tkind: Add an item. Set `kind` on each field and pass d…",
    ]);
  });

  it("checks static tool definitions like inline tools", () => {
    const issues = collectToolDescriptionIssues({
      "src/tool.ts": `
        export const readToolDefinition = zodToolDefinition({
          description: "Read a file at \`path\`.",
          inputSchema: z.object({ path: z.string().describe("File path.") }),
        });
      `,
    });

    assert.deepEqual(
      issues.map((issue) => issue.split("\t").slice(0, 2).join(" ")),
      ["src/tool.ts tool-description-names-param"],
    );
  });

  it("folds joined and templated descriptions before it measures them", () => {
    const long = "x".repeat(MAX_TOOL_DESCRIPTION_CHARS);
    const issues = collectToolDescriptionIssues({
      "src/tool.ts": `
        const TAIL = "${long}";
        zodTool({
          description: ["Read a file.", \`More: \${TAIL}\`].join(" "),
          inputSchema: z.object({
            path: z.string().describe("${"y".repeat(MAX_PARAM_DESCRIPTION_CHARS + 1)}"),
          }),
        });
        definePluginTool({
          description: renderDescription(),
          inputSchema: z.object({ path: z.string().describe("File path.") }),
        });
      `,
    });

    assert.deepEqual(
      issues.map((issue) => issue.split("\t").slice(0, 2).join(" ")),
      [
        "src/tool.ts param-description-length",
        "src/tool.ts tool-description-length",
      ],
    );
  });

  it("sees through type assertions on descriptions and joined arrays", () => {
    const issues = collectToolDescriptionIssues({
      "src/tool.ts": `
        const PARTS = ["Read a file.", "Pass \`path\`."] as const;
        zodTool({
          description: ("Write a file. Pass \`path\`." as const),
          inputSchema: z.object({ path: z.string().describe("File path.") }),
        });
        zodTool({
          description: PARTS.join(" ") satisfies string,
          inputSchema: z.object({ path: z.string().describe("File path.") }),
        });
      `,
    });

    assert.deepEqual(issues, [
      "src/tool.ts\ttool-description-names-param\tpath: Read a file. Pass `path`.",
      "src/tool.ts\ttool-description-names-param\tpath: Write a file. Pass `path`.",
    ]);
  });

  it("flags input fields without describe(), also behind shared params", () => {
    const issues = collectToolDescriptionIssues(
      {
        "src/params.ts": `
          export const teamSchema = z.string().describe("Team slug.");
          export const flag = (description) => z.boolean().describe(description);
        `,
        "src/tool.ts": `
          import { flag, teamSchema } from "./params.js";
          zodTool({
            description: "Search items.",
            inputSchema: z.object({
              team: teamSchema,
              exact: flag("Match the whole query."),
              loose: flag("Match part of the query."),
              limit: z.number().int(),
              filter: z
                .object({ since: z.string() })
                .describe("Filter for results."),
            }),
          });
        `,
      },
      { app: "src" },
    );

    assert.deepEqual(issues, [
      "src/tool.ts\tparam-missing-description\tlimit: Search items.",
      "src/tool.ts\tparam-missing-description\tsince: Search items.",
    ]);
  });

  it("treats only code spans and snake_case words as field names", () => {
    assert.equal(namesParam("Search by query.", "query"), false);
    assert.equal(namesParam("Pass `query` to search.", "query"), true);
    assert.equal(namesParam("Set `status: done`.", "status"), true);
    assert.equal(namesParam("Pass `query_text`.", "query"), false);
    assert.equal(namesParam("Pass the channel_id.", "channel_id"), true);
  });

  it("flags new issues and stale baseline entries", () => {
    const { unexpected, stale } = diffBaseline(
      [
        "a.ts\ttool-description-length\tkept",
        "b.ts\ttool-description-length\tnew",
      ],
      parseBaseline(
        "# comment\na.ts\ttool-description-length\tkept\nc.ts\ttool-description-length\tgone\n",
      ),
    );

    assert.deepEqual(unexpected, ["b.ts\ttool-description-length\tnew"]);
    assert.deepEqual(stale, ["c.ts\ttool-description-length\tgone"]);
  });
});
