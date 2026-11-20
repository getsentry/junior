import { expect, it } from "vitest";

import { mentionTokenAt } from "../src/client/conversations/composerMentionToken";

// `|` marks the caret.
const at = (text: string) => {
  const caret = text.indexOf("|");
  return mentionTokenAt(text.slice(0, caret) + text.slice(caret + 1), caret);
};

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("finds the people reference at the caret", () => {
  expect(at("@|")).toEqual({ start: 0, end: 1, query: "" });
  expect(at("hi @ri|")).toEqual({ start: 3, end: 6, query: "ri" });
  expect(at("(@ri|ley) now")).toEqual({ start: 1, end: 7, query: "ri" });
});

it("skips an at sign in an email address or after a space", () => {
  expect(at("me@exa|")).toBeUndefined();
  expect(at("müller@exa|")).toBeUndefined();
  expect(at("田中@exa|")).toBeUndefined();
  expect(at("@@x|")).toBeUndefined();
  expect(at("@riley |")).toBeUndefined();
});
