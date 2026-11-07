import { describe, expect, it } from "vitest";
import {
  isDeliberateSelection,
  markdownQuote,
} from "../src/client/conversations/selectionQuote";

describe("isDeliberateSelection", () => {
  it.each([
    "deployment",
    "QuickQuestionSelectionButton",
    "ck qu",
    "...",
    " — ",
    "東京",
  ])("ignores an accidental selection: %j", (text) => {
    expect(isDeliberateSelection(text)).toBe(false);
  });

  it.each([
    "rate limit",
    "The deploy failed on canary.",
    "getsentry/junior",
    "東京都に住んでいます",
  ])("accepts a deliberate selection: %j", (text) => {
    expect(isDeliberateSelection(text)).toBe(true);
  });
});

describe("markdownQuote", () => {
  it("quotes each line and keeps paragraph breaks inside the quote", () => {
    expect(markdownQuote("First line\nSecond line  \n\nNext paragraph")).toBe(
      "> First line\n> Second line\n>\n> Next paragraph",
    );
  });
});
