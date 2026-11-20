import * as z from "zod";
import {
  googleFileRequest,
  MAX_CONTENT_CHARS,
  type FileReference,
} from "./files";
import type { GoogleToolContext } from "./shared";

/** Output fields of `readGoogleFile` for a Sheet. */
export const sheetOutputFields = {
  ranges: z
    .array(
      z.object({
        content: z
          .string()
          .describe(
            "Cell values as CSV, as the Sheet shows them. Formulas are not included.",
          ),
        range: z.string().describe("The A1 range that Google read."),
        truncated: z
          .boolean()
          .describe("True when rows at the end of this range are left out."),
      }),
    )
    .optional()
    .describe("Only for Sheets."),
  tabs: z
    .array(z.string())
    .optional()
    .describe("Names of every tab in the Sheet. Only for Sheets."),
};

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
 * accepts the same `drive.readonly` scope as the Drive tools.
 */
export async function readSheetContent(
  ctx: GoogleToolContext,
  ref: FileReference,
  range: string | undefined,
) {
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
      ranges: range ? [range] : tabs.map(tabRange),
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
    ranges,
    tabs,
    truncated: ranges.some((range) => range.truncated),
  };
}
