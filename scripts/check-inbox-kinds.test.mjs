import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "./check-inbox-kinds.mjs";
import { CODE_HEADER_START } from "./inbox-kinds/render.mjs";
import {
  designRuleIds,
  linkProblems,
  subFeatureIds,
} from "./inbox-kinds/links.mjs";
import {
  MAX_COMBINATIONS,
  analyzeTable,
  parseCell,
  parseTable,
} from "./inbox-kinds/table.mjs";

const STATES = ["open", "merged", "closed"];
const STATE = { values: STATES };
const DRAFT = { values: "bool" };

function table(inputs, rules, extra = {}) {
  return parseTable(
    JSON.stringify({
      kind: "github:example",
      source: "github.example",
      hit: "first",
      feature: "github",
      inputs,
      ...extra,
      rules,
    }),
  );
}

function rule(id, rows, serves = ["first-rule-wins"]) {
  return { id, serves, rows };
}

function plain(values) {
  return { values };
}

test("parses each kind of unary test cell", () => {
  assert.deepEqual([...parseCell("-", STATES)], STATES);
  assert.deepEqual([...parseCell("merged", STATES)], ["merged"]);
  assert.deepEqual([...parseCell("open, closed", STATES)], ["open", "closed"]);
  assert.deepEqual([...parseCell("not(open)", STATES)], ["merged", "closed"]);
  assert.deepEqual([...parseCell("not(open, merged)", STATES)], ["closed"]);
  assert.deepEqual([...parseCell(false, ["true", "false"])], ["false"]);
});

test("rejects cells that name a value outside the domain", () => {
  assert.throws(() => parseCell("draft", STATES), /names `draft`/);
  assert.throws(() => parseCell("not()", STATES), /names ``/);
  assert.throws(() => parseCell("open, open", STATES), /names a value twice/);
  assert.throws(() => parseCell("yes", ["true", "false"]), /names `yes`/);
});

test("reads YAML 1.2, so `no` stays a string", () => {
  assert.throws(
    () =>
      parseTable(
        [
          "kind: github:example",
          "source: github.example",
          "hit: first",
          "feature: github",
          "code: packages/junior-github/src/example.generated.ts",
          "inputs: { draft: { values: bool } }",
          "rules:",
          "  - id: example",
          "    serves: [first-rule-wins]",
          "    rows: [{ when: { draft: no }, output: keep }]",
        ].join("\n"),
      ),
    /names `no`/,
  );
});

test("reads an input with a description", () => {
  const parsed = table(
    { asked: { values: "bool", description: "Junior asked." } },
    [rule("asked", [{ when: { asked: true }, output: "keep" }])],
  );
  assert.deepEqual(parsed.inputs, [
    {
      name: "asked",
      bool: true,
      domain: ["true", "false"],
      description: "Junior asked.",
    },
  ]);
});

test("rejects rows that test an input the table does not declare", () => {
  assert.throws(
    () =>
      table({ state: STATE }, [
        rule("example", [{ when: { draft: true }, output: "keep" }]),
      ]),
    /tests `draft`, which is no input/,
  );
});

test("accepts a table where each row is the first match for some input", () => {
  const parsed = table({ state: STATE, draft: DRAFT }, [
    rule("ended", [
      { when: { state: "merged" }, output: { close: "done" } },
      { when: { state: "closed" }, output: { close: "dismissed" } },
    ]),
    rule("ready", [
      { when: { draft: false }, output: { ask: { label: "Ready to merge" } } },
    ]),
  ]);
  assert.deepEqual(analyzeTable(parsed), []);
});

test("reports a row that earlier rows always match first", () => {
  const parsed = table({ state: STATE }, [
    rule("ended", [
      { when: { state: "not(open)" }, output: { close: "done" } },
    ]),
    rule("merged", [{ when: { state: "merged" }, output: { close: "done" } }]),
  ]);
  assert.deepEqual(analyzeTable(parsed), [
    "Rule `merged` row 1 can never be the first match.",
  ]);
});

test("reports an input that can be unknown when no rule names it", () => {
  const domain = ["clean", "blocked", "unknown"];
  const unnamed = table({ merge_state: plain(domain) }, [
    rule("ready", [{ when: { merge_state: "clean" }, output: "keep" }]),
    rule("other", [{ when: { merge_state: "not(clean)" }, output: "keep" }]),
  ]);
  assert.deepEqual(analyzeTable(unnamed), [
    "`merge_state` can be unknown, and no rule names `unknown`.",
  ]);
  const named = table({ merge_state: plain(domain) }, [
    rule("ready", [
      { when: { merge_state: "clean, unknown" }, output: "keep" },
    ]),
  ]);
  assert.deepEqual(analyzeTable(named), []);
});

test("reports a table with too many combinations to enumerate", () => {
  const inputs = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`input_${index}`, plain("bool")]),
  );
  assert.ok(2 ** 21 > MAX_COMBINATIONS);
  const parsed = table(inputs, [rule("example", [{ output: "keep" }])]);
  assert.deepEqual(analyzeTable(parsed), [
    `The inputs have ${2 ** 21} combinations, more than the ${MAX_COMBINATIONS} that the check can enumerate. Split the kind or make its domains smaller.`,
  ]);
});

test("reads the rule IDs of a design file, but not its Gap lines", () => {
  const markdown = [
    "## Rules",
    "",
    "- `dismiss-holds` A dismiss holds while the output comes from the",
    "  same rule.",
    "",
    "## Gaps",
    "",
    "- `dismiss-holds`: nothing checks it.",
  ].join("\n");
  assert.deepEqual(designRuleIds(markdown), ["dismiss-holds"]);
});

test("reads only the Sub-features of a verification map file", () => {
  const markdown = [
    "## Sub-features",
    "",
    "- `pr-merge` The requester gets Ready to merge.",
    "",
    "## Driving it with gh",
    "",
    "- `not-a-sub-feature` A driving step.",
  ].join("\n");
  assert.deepEqual(subFeatureIds(markdown), ["pr-merge"]);
});

test("reports a rule that serves an unknown ID or has no sub-feature", () => {
  const parsed = table({ state: STATE }, [
    rule(
      "ended",
      [{ when: { state: "not(open)" }, output: { close: "done" } }],
      ["first-rule-wins", "no-such-rule"],
    ),
    rule("ready", [{ output: "keep" }]),
  ]);
  assert.deepEqual(
    linkProblems(parsed, new Set(["first-rule-wins"]), new Set(["ended"])),
    [
      "Rule `ended` serves `no-such-rule`, which no design/*.md rule has.",
      "Rule `ready` has no line in the Sub-features of .agents/skills/verify-junior/features/github.md.",
    ],
  );
  assert.deepEqual(linkProblems(parsed, new Set(), undefined), [
    "`feature: github` names no file .agents/skills/verify-junior/features/github.md.",
  ]);
});

test("rejects a rule that serves no design rule", () => {
  assert.throws(
    () => table({ state: STATE }, [rule("ended", [{ output: "keep" }], [])]),
    /serves/,
  );
});

test("keeps the generated file of a table that fails to parse", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-kinds-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("packages/x/src/broken-kind.yaml", "kind: [");
  write(
    "packages/x/src/broken.generated.ts",
    `${CODE_HEADER_START}broken-kind.yaml.\n`,
  );
  write(
    "packages/x/src/gone.generated.ts",
    `${CODE_HEADER_START}gone-kind.yaml.\n`,
  );
  const problems = await run({
    root,
    files: [
      "packages/x/src/broken-kind.yaml",
      "packages/x/src/broken.generated.ts",
      "packages/x/src/gone.generated.ts",
    ],
    args: [],
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^packages\/x\/src\/broken-kind\.yaml: /);
  assert.equal(
    problems[1],
    "packages/x/src/gone.generated.ts: no table generates it. Delete it.",
  );
});
