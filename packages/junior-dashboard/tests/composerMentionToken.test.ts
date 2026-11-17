import { expect, it } from "vitest";

import {
  mentionTokenAt,
  splitMentions,
} from "../src/client/conversations/composerMentionToken";

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
  expect(at("@@x|")).toBeUndefined();
  expect(at("@riley |")).toBeUndefined();
});

it("splits Slack mention tokens out of message text", () => {
  expect(splitMentions("hi <@U789> and <@U456>!")).toEqual([
    { text: "hi " },
    { slackUserId: "U789" },
    { text: " and " },
    { slackUserId: "U456" },
    { text: "!" },
  ]);
  expect(splitMentions("no <@mention> here")).toEqual([
    { text: "no <@mention> here" },
  ]);
});
