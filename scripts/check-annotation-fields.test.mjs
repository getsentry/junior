import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFields,
  droppedReads,
  objectKeys,
  schemaColumns,
} from "./check-annotation-fields.mjs";

test("reads the Annotation columns of the schema source", () => {
  const source = `export const juniorConversationAnnotations = pgTable(
  "junior_conversation_annotations",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.id, { onDelete: "cascade" }),
    title: text("title"),
  },
  (table) => [index("x").on(table.title)],
);`;
  assert.deepEqual(schemaColumns(source), ["conversation_id", "title"]);
});

test("reads the keys of a saved Annotation schema", () => {
  const source = `export const savedObjectAnnotationSchema = z
  .object({
    kind: z.literal("object"),
    url: z
      .url()
      .nullable(),
  })
  .strict();
`;
  assert.deepEqual(
    objectKeys(source, "export const savedObjectAnnotationSchema = z"),
    ["kind", "url"],
  );
});

test("reports a dropped field that source reads from the stored JSON", () => {
  const errors = droppedReads(
    "src/x.ts",
    [
      "sql`${annotations.annotation}->>'title'`;",
      "sql`annotation_json->>'status'`;",
      "sql`${juniorConversationAnnotations.annotation}->'facts'`;",
    ].join("\n"),
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^src\/x\.ts:2: reads "status"/);
  assert.match(errors[1], /^src\/x\.ts:3: reads "facts"/);
});

test("reports a new field and a stale baseline entry", () => {
  const errors = compareFields(
    "junior_conversation_annotations",
    ["key", "status"],
    ["key", "label"],
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /"status" is not in .*live card/);
  assert.match(errors[1], /"label" is gone/);
});
