import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFields,
  payloadFields,
  schemaColumns,
} from "./check-inbox-item-fields.mjs";

const SOURCE = `export const inboxItemSchema = z
  .object({
    id: z.string().min(1),
    subject: z
      .object({
        id: z.string().min(1),
        kind: z.string().min(1),
      })
      .strict(),
    title: z.string().min(1),
  })
  .strict();
`;

test("reads the payload and subject fields", () => {
  assert.deepEqual(payloadFields(SOURCE), {
    payload: ["id", "subject", "title"],
    subject: ["id", "kind"],
  });
});

test("reads the Inbox item columns of the schema source", () => {
  const source = `export const juniorInboxItems = pgTable(
  "junior_inbox_items",
  {
    id: text("id").primaryKey(),
    subjectKind: text("subject_kind").notNull(),
    closedByUserId: text("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("x").on(table.id)],
);`;
  assert.deepEqual(schemaColumns(source), [
    "id",
    "subject_kind",
    "closed_by_user_id",
  ]);
});

test("reports a new field and a stale baseline entry", () => {
  const errors = compareFields(
    "junior_inbox_items",
    ["id", "subject_state"],
    ["id", "subject_url"],
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /"subject_state" is not in .*stores only fields/);
  assert.match(errors[1], /"subject_url" is gone/);
});
