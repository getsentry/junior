import assert from "node:assert/strict";
import test from "node:test";
import { embedRuleList, renderRuleList } from "./inbox-kinds/render.mjs";
import { ruleText } from "./inbox-kinds/text.mjs";
import {
  MAX_COMBINATIONS,
  analyzeTable,
  parseCell,
  parseTable,
} from "./inbox-kinds/table.mjs";

const STATES = ["open", "merged", "closed"];
const STATE = {
  values: STATES,
  phrases: { open: "it is open", merged: "it merged", closed: "it closed" },
};
const DRAFT = {
  values: "bool",
  phrases: { true: "it is a draft", false: "it is not a draft" },
};

function table(inputs, rules, extra = {}) {
  return parseTable(
    JSON.stringify({
      kind: "github:example",
      source: "github.example",
      hit: "first",
      doc: "design/github.md",
      inputs,
      ...extra,
      rules,
    }),
  );
}

function rule(id, rows) {
  return { id, rows };
}

/** An input whose phrases are its values. */
function plain(values) {
  const domain = values === "bool" ? ["true", "false"] : values;
  return {
    values,
    phrases: Object.fromEntries(domain.map((item) => [item, item])),
  };
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
          "doc: design/github.md",
          "code: packages/junior-github/src/example.generated.ts",
          "inputs: { draft: { values: bool, phrases: {} } }",
          "rules:",
          "  - id: example",
          "    rows: [{ when: { draft: no }, output: keep }]",
        ].join("\n"),
      ),
    /names `no`/,
  );
});

test("reads an input with a description", () => {
  const parsed = table(
    { asked: { values: "bool", phrases: {}, text: "Junior asked." } },
    [rule("asked", [{ when: { asked: true }, output: "keep" }])],
  );
  assert.deepEqual(parsed.inputs, [
    {
      name: "asked",
      bool: true,
      domain: ["true", "false"],
      phrases: {},
      text: "Junior asked.",
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

test("embeds the rule list between the markers of its table", () => {
  const parsed = table({ state: STATE }, [
    rule("ended", [
      { when: { state: "not(open)" }, output: { close: "done" } },
    ]),
  ]);
  const start = "<!-- Generated from inbox-kinds/example.yaml. -->";
  const end = "<!-- End of inbox-kinds/example.yaml. -->";
  const doc = ["# Example", start, "- `old` Old text.", end, ""].join("\n");
  assert.equal(
    embedRuleList(
      doc,
      "design/inbox-kinds/example.yaml",
      renderRuleList(parsed),
    ),
    [
      "# Example",
      start,
      "- `ended` When it merged or closed, nobody gets it.",
      end,
      "",
    ].join("\n"),
  );
  assert.throws(
    () => embedRuleList("# Example\n", "design/inbox-kinds/example.yaml", ""),
    /needs the lines/,
  );
});

test("generates each rule's text from its rows and phrases", () => {
  const parsed = table(
    {
      state: STATE,
      draft: DRAFT,
      requester: {
        values: "bool",
        phrases: {
          true: { is: "they are the requester", who: "the requester" },
          false: { is: "they are not the requester", who: "a reviewer" },
        },
      },
      requested: plain("bool"),
      replied: {
        values: "bool",
        phrases: { false: "they did not reply" },
      },
    },
    [
      rule("ended", [
        { when: { state: "merged" }, output: { close: "done" } },
        { when: { state: "closed" }, output: { close: "dismissed" } },
      ]),
      rule("ready", [
        {
          when: { draft: false, requester: true },
          output: { ask: { label: "Ready to merge" } },
        },
        { when: { draft: "not(false)" }, output: "keep" },
      ]),
      rule("review", [
        {
          when: { state: "open", requester: false },
          output: { ask: { label: "Review", dismiss: "remove" } },
        },
        {
          when: { state: "open", replied: false },
          output: { ask: { label: "Review", dismiss: "remove" } },
        },
      ]),
      rule("show", [
        {
          when: { requester: true },
          output: { notice: { step: "with the next step" } },
        },
      ]),
    ],
    { commands: { remove: "removes them" } },
  );
  const [ended, ready, review, show] = parsed.rules.map((item) =>
    ruleText(parsed, item),
  );
  assert.equal(ended, "When it merged or closed, nobody gets it.");
  assert.equal(
    ready,
    'When it is not a draft, the requester gets "Ready to merge". When it is a draft, their output stays as it is.',
  );
  assert.equal(
    review,
    'When it is open and either they are not the requester or did not reply, they get "Review". Dismiss removes them.',
  );
  assert.equal(show, "The requester gets a notice with the next step.");
});

test("reports a row that names a value with no phrase", () => {
  const parsed = table({ state: { values: STATES, phrases: {} } }, [
    rule("ended", [{ when: { state: "merged" }, output: { close: "done" } }]),
  ]);
  assert.throws(
    () => renderRuleList(parsed),
    /Rule `ended` row 1: `state` value `merged` has no phrase/,
  );
  const missingCommand = table({ state: STATE }, [
    rule("ask", [{ output: { ask: { label: "Ask", dismiss: "drop" } } }]),
  ]);
  assert.throws(
    () => renderRuleList(missingCommand),
    /command `drop` has no phrase/,
  );
});
