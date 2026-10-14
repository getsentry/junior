import {
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  fileOutputFields,
  fileReferenceSchema,
  googleFileRequest,
  MAX_CONTENT_CHARS,
  parseFileReference,
  readGoogleFile,
} from "./files";
import type { GoogleToolContext } from "./shared";

const inputSchema = z
  .object({
    spreadsheet: fileReferenceSchema("Google Sheets"),
    range: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "A1 range to read, such as 'Budget' for one tab or 'Budget!A1:F50'. Omit to read every tab.",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("readGoogleSheet"),
  modifiedTime: z.string().optional(),
  ranges: z.array(
    z.object({
      content: z
        .string()
        .describe("Cell values as CSV, as the Sheet shows them."),
      range: z.string().describe("The A1 range that Google read."),
      truncated: z
        .boolean()
        .describe("True when rows at the end of this range are left out."),
    }),
  ),
  spreadsheetId: z.string(),
  tabs: z.array(z.string()).describe("Names of every tab in the Sheet."),
  title: z.string(),
  truncated: z
    .boolean()
    .describe(
      `True when the cells are longer than ${MAX_CONTENT_CHARS} characters and some rows are left out. Pass a smaller range to read them.`,
    ),
  url: z.string().optional(),
});

const spreadsheetSchema = z.object({
  sheets: z
    .array(
      z.object({
        properties: z.object({
          sheetType: z.string().optional(),
          title: z.string(),
        }),
      }),
    )
    .default([]),
});

const valuesSchema = z.object({
  valueRanges: z
    .array(
      z.object({
        range: z.string(),
        values: z.array(z.array(z.unknown())).default([]),
      }),
    )
    .default([]),
});

/** Quote a tab name for an A1 range. */
function tabRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Read the cells of one Google Sheet as CSV, one entry per range.
 *
 * A Drive CSV export has only the first tab, so this uses the Sheets API. It
 * accepts the same `drive` scope as the Drive tools.
 */
export function createReadGoogleSheetTool(ctx: GoogleToolContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Read the cells of one Google Sheet as CSV, as Junior's own Google account sees it. Reads every tab, or one A1 range. Values are formatted as the Sheet shows them; formulas are not included. Works for Sheets shared with that account and Sheets shared with anyone who has the link. Comments are not included; use listGoogleFileComments for them. Sheet contents can be private: share only what the requester needs, and avoid repeating them in public channels.",
    inputSchema,
    outputSchema,
    async execute(input) {
      const ref = parseFileReference(input.spreadsheet);
      const file = await readGoogleFile(ctx, ref, ["spreadsheet"]);
      const spreadsheet = await googleFileRequest(ctx, ref, {
        operation: "google.sheets.spreadsheet.get",
        path: `/v4/spreadsheets/${ref.fileId}`,
        query: { fields: "sheets.properties(sheetType,title)" },
      });
      // Chart tabs have no cells.
      const tabs = spreadsheetSchema
        .parse(spreadsheet.body)
        .sheets.map((sheet) => sheet.properties)
        .filter((tab) => (tab.sheetType ?? "GRID") === "GRID")
        .map((tab) => tab.title);
      const values = await googleFileRequest(ctx, ref, {
        operation: "google.sheets.values.batchGet",
        path: `/v4/spreadsheets/${ref.fileId}/values:batchGet`,
        query: {
          majorDimension: "ROWS",
          ranges: input.range ? [input.range] : tabs.map(tabRange),
          valueRenderOption: "FORMATTED_VALUE",
        },
      });
      const { valueRanges } = valuesSchema.parse(values.body);

      let remaining = MAX_CONTENT_CHARS;
      const ranges = valueRanges.map(({ range, values }) => {
        const rows: string[] = [];
        for (const row of values) {
          const line = row.map(csvCell).join(",");
          if (line.length + 1 > remaining) break;
          rows.push(line);
          remaining -= line.length + 1;
        }
        return {
          content: rows.join("\n"),
          range,
          truncated: rows.length < values.length,
        };
      });
      return {
        target: "readGoogleSheet" as const,
        ...fileOutputFields(file),
        ranges,
        spreadsheetId: file.id,
        tabs,
        title: file.name,
        truncated: ranges.some((range) => range.truncated),
      };
    },
  });
}
