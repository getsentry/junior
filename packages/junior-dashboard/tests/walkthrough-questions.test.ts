import { describe, expect, it } from "vitest";

import {
  chapterQuestion,
  claimQuestions,
  readChapterQuestion,
} from "../src/client/walkthrough/walkthroughModel";

describe("Walkthrough questions", () => {
  it("names the chapter in the question and reads it back", () => {
    const message = chapterQuestion(
      { title: "A click claims a version." },
      "What if two people click at once?",
    );
    expect(message).toBe(
      "> **A click claims a version.**\n\nWhat if two people click at once?",
    );
    expect(readChapterQuestion(message)).toEqual({
      chapter: "A click claims a version.",
      text: "What if two people click at once?",
    });
    expect(readChapterQuestion("Which PR first?")).toEqual({
      text: "Which PR first?",
    });
  });

  it("quotes a claim under the chapter and finds the claims asked about", () => {
    const message = chapterQuestion(
      {
        title: "A click claims a version.",
        claim: "The 80-call and $5 caps\nare safe defaults.",
      },
      "Why 80?",
    );
    expect(message).toBe(
      "> **A click claims a version.**\n> The 80-call and $5 caps are safe defaults.\n\nWhy 80?",
    );
    expect(readChapterQuestion(message)).toEqual({
      chapter: "A click claims a version.",
      claim: "The 80-call and $5 caps are safe defaults.",
      text: "Why 80?",
    });
    const claim = "The 80-call and $5 caps are safe defaults.";
    expect(claimQuestions([{ role: "user", text: message }])).toEqual(
      new Map([[claim, { answered: false }]]),
    );
    expect(
      claimQuestions([
        { role: "user", text: message },
        { role: "assistant", text: "Because…" },
      ]),
    ).toEqual(new Map([[claim, { answered: true }]]));
  });
});
