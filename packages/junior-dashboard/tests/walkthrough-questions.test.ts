import { describe, expect, it } from "vitest";

import {
  chapterQuestion,
  readChapterQuestion,
} from "../src/client/walkthrough/walkthroughModel";

describe("Walkthrough questions", () => {
  it("names the chapter in the question and reads it back", () => {
    const message = chapterQuestion(
      { title: "The change", caption: "A click claims a version." },
      "What if two people click at once?",
    );
    expect(message).toBe(
      "> **The change** · A click claims a version.\n\nWhat if two people click at once?",
    );
    expect(readChapterQuestion(message)).toEqual({
      chapter: "The change",
      text: "What if two people click at once?",
    });
    expect(readChapterQuestion("Which PR first?")).toEqual({
      text: "Which PR first?",
    });
  });
});
