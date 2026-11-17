import { expect, it } from "vitest";

import { skillTokenAt } from "../src/client/conversations/composerSkillToken";

const at = (text: string) =>
  skillTokenAt(text.replace("|", ""), text.indexOf("|"));

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
