import { expect, it } from "vitest";

import {
  findSkillReferences,
  skillTokenAt,
} from "../src/client/conversations/skillReferences";

// `|` marks the caret.
const at = (text: string) => {
  const caret = text.indexOf("|");
  return skillTokenAt(text.slice(0, caret) + text.slice(caret + 1), caret);
};

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("finds the skill reference at the caret", () => {
  expect(at("$|")).toEqual({ start: 0, end: 1, query: "" });
  expect(at("run $rev|")).toEqual({ start: 4, end: 8, query: "rev" });
  expect(at("($rev|iew-pr) now")).toEqual({ start: 1, end: 11, query: "rev" });
});

it("skips a dollar after a word or outside a name", () => {
  expect(at("US$5|")).toBeUndefined();
  expect(at("$$x|")).toBeUndefined();
  expect(at("$review |")).toBeUndefined();
});

it("finds each complete skill reference the runtime reads", () => {
  expect(findSkillReferences("use $brief, then ($Review-PR).")).toEqual([
    { start: 4, end: 10, name: "brief" },
    { start: 18, end: 28, name: "review-pr" },
  ]);
  expect(findSkillReferences("US$5 $$x $ $-x")).toEqual([]);
  expect(findSkillReferences("$brief-")).toEqual([
    { start: 0, end: 6, name: "brief" },
  ]);
});
