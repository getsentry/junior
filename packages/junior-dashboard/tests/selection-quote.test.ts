import { expect, it } from "vitest";
import {
  isDeliberateSelection,
  markdownQuote,
} from "../src/client/conversations/selectionQuote";

it("ignores accidental selections", () => {
  for (const text of [
    "deployment",
    "QuickQuestionSelectionButton",
    "ck qu",
    "...",
    " — ",
    "東京",
  ]) {
    expect(isDeliberateSelection(text), text).toBe(false);
  }
});

it("accepts deliberate selections", () => {
  for (const text of [
    "rate limit",
    "The deploy failed on canary.",
    "getsentry/junior",
    "東京都に住んでいます",
  ]) {
    expect(isDeliberateSelection(text), text).toBe(true);
  }
});

it("quotes each line and keeps paragraph breaks inside the quote", () => {
  expect(markdownQuote("First line\nSecond line  \n\nNext paragraph")).toBe(
    "> First line\n> Second line\n>\n> Next paragraph",
  );
});
