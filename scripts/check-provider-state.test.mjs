import assert from "node:assert/strict";
import test from "node:test";
import { checkSnapshot } from "./check-provider-state.mjs";

function snapshot(table, columns) {
  return {
    tables: {
      [`public.${table}`]: {
        name: table,
        columns: Object.fromEntries(columns.map((name) => [name, { name }])),
      },
    },
  };
}

const message = (key) =>
  `0001_snapshot.json: ${key} copies GitHub state. Read it from GitHub through the plugin cache (design/github.md). If it is a Junior-owned fact or too expensive to derive, ask the owner to add it to scripts/github-state-exceptions.json with the reason.`;

test("reports every GitHub plugin column that is not an exception", () => {
  assert.deepEqual(
    checkSnapshot(
      "junior-github",
      "0001_snapshot.json",
      snapshot("junior_github_reviews", ["review_id", "body"]),
      { junior_github_reviews: { review_id: "Junior-owned: the key." } },
    ),
    [message("junior_github_reviews.body")],
  );
});

test("reports provider state names on tables with provider ids", () => {
  assert.deepEqual(
    checkSnapshot(
      "junior",
      "0001_snapshot.json",
      snapshot("junior_code_reviews", [
        "provider_id",
        "state",
        "comment_count",
        "labels",
        "title",
        "body",
      ]),
      { junior_code_reviews: { title: "Too expensive to derive: search." } },
    ),
    [
      message("junior_code_reviews.state"),
      message("junior_code_reviews.comment_count"),
      message("junior_code_reviews.labels"),
    ],
  );
});

test("accepts every column of a table with a table reason", () => {
  assert.deepEqual(
    checkSnapshot(
      "junior-github",
      "0001_snapshot.json",
      snapshot("junior_github_reviews", ["review_id", "state"]),
      { junior_github_reviews: "Junior-owned: the reviews Junior wrote." },
    ),
    [],
  );
});

test("accepts provider state names on tables without provider ids", () => {
  assert.deepEqual(
    checkSnapshot(
      "junior",
      "0001_snapshot.json",
      snapshot("junior_inbox_items", ["id", "title", "provider_tenant_id"]),
      {},
    ),
    [],
  );
});
