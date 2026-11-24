import fs from "node:fs";
import path from "node:path";

/**
 * Inbox item field check. An Inbox item stores only fields that every item
 * uses, and its subject: a `{ kind, id }` pair. The title, state, and link
 * of the subject come from the subject when Junior reads the item
 * (design/inbox.md). This check fails when a column of
 * `junior_inbox_items`, a field of the Inbox item payload, or a field of
 * its subject is not in `BASELINE`. The baseline-growth check lets the
 * baseline only shrink, so a new field needs a change of the design first.
 */

const BASELINE = "scripts/inbox-item-fields-baseline.json";
const SCHEMA = "packages/junior/src/db/schema/inbox-items.ts";
const PAYLOAD_SCHEMA = "packages/junior/src/api/schema/inbox-item.ts";
const TABLE = "junior_inbox_items";
const FIX =
  "An Inbox item stores only fields that every item uses, and its subject { kind, id }. Read a field that one subject kind uses, such as a state, a title, or a provider id, from the subject (design/inbox.md).";

/**
 * Return the column names of the Inbox item table in the Drizzle schema
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
 * Return the keys of one `z.object({ ... })` in the payload schema source:
 * the keys at `indent` from the line that starts with `start` to the line
 * that closes the object.
 */
function objectKeys(lines, start, indent) {
  const from = lines.findIndex((line) => line.startsWith(start));
  if (from === -1) return undefined;
  const key = new RegExp(`^ {${indent}}([A-Za-z0-9_]+):`);
  const end = new RegExp(`^ {${indent - 2}}\\}\\)`);
  const keys = [];
  for (const line of lines.slice(from + 1)) {
    if (end.test(line)) break;
    const match = key.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Return the payload fields and subject fields of the payload schema source. */
export function payloadFields(source) {
  const lines = source.split("\n");
  return {
    payload: objectKeys(lines, "export const inboxItemSchema = z", 4),
    subject: objectKeys(lines, "    subject: z", 8),
  };
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

/** Check the table schema and the payload schema against the baseline. */
export function run({ root }) {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, BASELINE), "utf8"),
  );
  const fields = payloadFields(
    fs.readFileSync(path.join(root, PAYLOAD_SCHEMA), "utf8"),
  );
  return [
    ...compareFields(
      `${SCHEMA} ${TABLE}`,
      schemaColumns(fs.readFileSync(path.join(root, SCHEMA), "utf8")),
      baseline.columns,
    ),
    ...compareFields(
      `${PAYLOAD_SCHEMA} inboxItemSchema`,
      fields.payload,
      baseline.payload,
    ),
    ...compareFields(
      `${PAYLOAD_SCHEMA} inboxItemSchema.subject`,
      fields.subject,
      baseline.subject,
    ),
  ];
}
