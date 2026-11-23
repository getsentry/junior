import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFields,
  payloadFields,
  snapshotColumns,
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

test("reads the Inbox item columns of a snapshot", () => {
  const snapshot = {
    tables: {
      "public.junior_inbox_items": {
        name: "junior_inbox_items",
        columns: { id: {}, subject_kind: {} },
      },
    },
  };
  assert.deepEqual(snapshotColumns(snapshot), ["id", "subject_kind"]);
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
