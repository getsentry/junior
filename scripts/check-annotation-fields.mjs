import fs from "node:fs";
import path from "node:path";

/**
 * Annotation field check (design/annotations.md says what an Annotation
 * stores). It fails when a column of `junior_conversation_annotations` or a
 * saved plugin field is not in `BASELINE`, or when source reads a field
 * that Annotations no longer store. The baseline may only shrink.
 */

const BASELINE = "scripts/annotation-fields-baseline.json";
const SCHEMA = "packages/junior/src/db/schema/conversation-annotations.ts";
const TABLE = "junior_conversation_annotations";
const SAVED_SCHEMAS = [
  {
    entry: "object",
    file: "packages/junior-plugin-api/src/object-annotations.ts",
    start: "export const savedObjectAnnotationSchema = z",
  },
  {
    entry: "resourceLink",
    file: "packages/junior-plugin-api/src/annotations.ts",
    start: "export const resourceLinkAnnotationSchema = z",
  },
];
// Fields that old Annotations kept in their JSON. A migration trigger
// strips them from rows that old workers write.
const DROPPED = new Set([
  "description",
  "displayType",
  "facts",
  "label",
  "sourceUpdatedAt",
  "status",
  "trigger",
  "warning",
]);
const SOURCE_FILE = /\.(?:m?js|tsx?)$/;
const TEST_FILE = /\.test\.(?:m?js|tsx?)$/;
// A JSON operator on the stored Annotation JSON, such as
// `annotation_json->>'status'` or `${annotations.annotation}->'facts'`.
const JSON_READ =
  /(?:annotation_json|[Aa]nnotations\.annotation\})\s*(?:->>?|#>>?\s*'\{|\?)\s*'?([A-Za-z]+)/g;
const FIX =
  "An Annotation stores the object's subject, the title, and the link. Read the label and the state from the plugin's live card (design/annotations.md).";

/**
 * Return the column names of the Annotation table in the Drizzle schema
 * source: the names in the column object of its `pgTable` call.
 */
export function schemaColumns(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `"${TABLE}",`);
  if (start === -1) return undefined;
  const column = /^ {4}[A-Za-z0-9]+: [A-Za-z0-9]+\("([a-z0-9_]+)"/;
  const columns = [];
  for (const line of lines.slice(start + 2)) {
    if (line.startsWith("  }")) break;
    const match = column.exec(line);
    if (match) columns.push(match[1]);
  }
  return columns;
}

/**
 * Return the keys of the `z.object({ ... })` that starts on the line that
 * starts with `start`: the keys at four spaces up to the line that closes
 * the object.
 */
export function objectKeys(source, start) {
  const lines = source.split("\n");
  const from = lines.findIndex((line) => line.startsWith(start));
  if (from === -1) return undefined;
  const keys = [];
  for (const line of lines.slice(from + 1)) {
    if (/^ {2}\}\)/.test(line)) break;
    const match = /^ {4}([A-Za-z0-9_]+):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Report each read of a dropped field from the stored Annotation JSON. */
export function droppedReads(filePath, source) {
  return [...source.matchAll(JSON_READ)]
    .filter((match) => DROPPED.has(match[1]))
    .map((match) => {
      const line = source.slice(0, match.index).split("\n").length;
      return `${filePath}:${line}: reads "${match[1]}" from the stored Annotation JSON. ${FIX}`;
    });
}

/** Report each field that `allowed` does not list, and each stale entry. */
export function compareFields(where, fields, allowed) {
  if (!fields) return [`${where}: the check cannot find these fields.`];
  const errors = fields
    .filter((field) => !allowed.includes(field))
    .map((field) => `${where}: "${field}" is not in ${BASELINE}. ${FIX}`);
  for (const field of allowed) {
    if (!fields.includes(field)) {
      errors.push(
        `${where}: "${field}" is gone. Remove it from ${BASELINE}, so the list shrinks.`,
      );
    }
  }
  return errors;
}

/** Check the table, the saved shapes, and production source. */
export function run({ root, files }) {
  const read = (filePath) => fs.readFileSync(path.join(root, filePath), "utf8");
  const baseline = JSON.parse(read(BASELINE));
  return [
    ...compareFields(
      `${SCHEMA} ${TABLE}`,
      schemaColumns(read(SCHEMA)),
      baseline.columns,
    ),
    ...SAVED_SCHEMAS.flatMap(({ entry, file, start }) =>
      compareFields(
        `${file} ${start.split(" ")[2]}`,
        objectKeys(read(file), start),
        baseline[entry],
      ),
    ),
    ...files
      .filter(
        (filePath) =>
          /^packages\/[^/]+\/src\//.test(filePath) &&
          SOURCE_FILE.test(filePath) &&
          !TEST_FILE.test(filePath),
      )
      .flatMap((filePath) => droppedReads(filePath, read(filePath))),
  ];
}
