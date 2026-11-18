import assert from "node:assert/strict";
import test from "node:test";
import { checkSnapshotColumns, checkSource } from "./check-money-units.mjs";

function snapshot(columns) {
  return {
    tables: {
      "public.junior_example": {
        name: "junior_example",
        columns: Object.fromEntries(
          columns.map(([name, type]) => [name, { name, type }]),
        ),
      },
    },
  };
}

test("accepts bigint micro-USD money columns and other columns", () => {
  assert.deepEqual(
    checkSnapshotColumns(
      "0001_snapshot.json",
      snapshot([
        ["cost_micro_usd", "bigint"],
        ["usage_json", "jsonb"],
        ["count", "integer"],
      ]),
    ),
    [],
  );
});

test("reports money columns in another type or unit", () => {
  assert.deepEqual(
    checkSnapshotColumns(
      "0001_snapshot.json",
      snapshot([
        ["cost_usd", "double precision"],
        ["spend_micro_usd", "integer"],
        ["price_cents", "bigint"],
      ]),
    ),
    [
      "0001_snapshot.json: junior_example.cost_usd is double precision. Store money as a bigint column named *_micro_usd.",
      "0001_snapshot.json: junior_example.spend_micro_usd is integer. Store money as a bigint column named *_micro_usd.",
      "0001_snapshot.json: junior_example.price_cents is bigint. Store money as a bigint column named *_micro_usd.",
    ],
  );
});

test("accepts micro-USD names and money scales in the helper", () => {
  assert.deepEqual(
    checkSource(
      "packages/junior/src/chat/example.ts",
      'const metric = "warmup_cost_micro_usd";\nconst label = "cost";\nconst read = price / 1_000_000;',
    ),
    [],
  );
  assert.deepEqual(
    checkSource(
      "packages/junior/src/db/micro-usd.ts",
      "const MICRO_USD_PER_USD = 1_000_000;\nreturn usd * MICRO_USD_PER_USD;",
    ),
    [],
  );
});

test("reports money names in another unit and ad-hoc money scales", () => {
  assert.deepEqual(
    checkSource(
      "packages/junior/src/chat/example.ts",
      [
        'const metric = "cost_usd";',
        "const UNITS_PER_USD = 10_000;",
        "sql`round(${cost} * 1000000)::bigint`;",
        "const micro = usd * 1e6;",
      ].join("\n"),
    ),
    [
      'packages/junior/src/chat/example.ts:1: "cost_usd" names money. Store it in micro-USD and name it *_micro_usd.',
      "packages/junior/src/chat/example.ts:2: money scale outside packages/junior/src/db/micro-usd.ts. Convert USD with its helpers.",
      "packages/junior/src/chat/example.ts:3: money scale outside packages/junior/src/db/micro-usd.ts. Convert USD with its helpers.",
      "packages/junior/src/chat/example.ts:4: money scale outside packages/junior/src/db/micro-usd.ts. Convert USD with its helpers.",
    ],
  );
});
