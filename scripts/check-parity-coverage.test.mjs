import assert from "node:assert/strict";
import test from "node:test";
import { coverageProblems, namedRowIds } from "./check-parity-coverage.mjs";

const rows = [
  { id: "intake:a" },
  { id: "intake:b" },
  { id: "delivery:c", engineNeutral: true },
];

test("reads the row ids that a parity test names", () => {
  assert.deepEqual(
    namedRowIds(
      `it("stops", () => { proves("turn-lifecycle:stop-cutoff"); key = "turn:1"; })`,
    ),
    ["turn-lifecycle:stop-cutoff", "turn:1"],
  );
});

test("passes when every row is covered, engine-neutral, or listed", () => {
  assert.deepEqual(
    coverageProblems({
      rows,
      uncovered: ["intake:b"],
      references: [["parity/a.test.ts", ["intake:a", "turn:1"]]],
    }),
    [],
  );
});

test("fails a row with no test that the list does not name", () => {
  const problems = coverageProblems({ rows, uncovered: [], references: [] });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"intake:a" has no parity test/);
});

test("fails a listed row that a test now covers, so the list shrinks", () => {
  const problems = coverageProblems({
    rows,
    uncovered: ["intake:a", "intake:b", "delivery:c"],
    references: [["parity/a.test.ts", ["intake:a"]]],
  });
  assert.deepEqual(problems.length, 2);
  assert.match(problems[0], /"intake:a" is covered/);
  assert.match(problems[1], /"delivery:c" is covered/);
});

test("fails stale list entries and tests that name unknown rows", () => {
  const problems = coverageProblems({
    rows,
    uncovered: ["intake:b", "intake:gone"],
    references: [["parity/a.test.ts", ["intake:a", "intake:typo"]]],
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"intake:typo" is not a row/);
  assert.match(problems[1], /"intake:gone" is not a row/);
});

test("fails duplicate and malformed row ids", () => {
  const problems = coverageProblems({
    rows: [{ id: "intake:a" }, { id: "intake:a" }, { id: "Bad" }],
    uncovered: ["intake:a", "Bad"],
    references: [],
  });
  assert.match(problems.join("\n"), /"Bad" is not a <domain>:<slug> id/);
  assert.match(problems.join("\n"), /"intake:a" is listed twice/);
});
