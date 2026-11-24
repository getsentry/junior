import {
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
} from "lexical";
import { expect, it } from "vitest";

import { parseMarkdownLines } from "../src/client/conversations/composer-editor/composerMarkdownSyntax";

// Each run as `text` for text, `[text]` for a marker, with its format.
function runs(line: string) {
  const [parsed] = parseMarkdownLines([line]);
  expect(parsed!.segments.map((segment) => segment.text).join("")).toBe(line);
  return parsed!.segments.map((segment) => [
    segment.marker ? `[${segment.text}]` : segment.text,
    segment.format,
  ]);
}

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("splits inline Markdown into markers and styled text", () => {
  expect(runs("a **b** _c_ `d` ~~e~~ [f](https://x.y)")).toEqual([
    ["a ", 0],
    ["[**]", IS_BOLD],
    ["b", IS_BOLD],
    ["[**]", IS_BOLD],
    [" ", 0],
    ["[_]", IS_ITALIC],
    ["c", IS_ITALIC],
    ["[_]", IS_ITALIC],
    [" ", 0],
    ["[`]", 0],
    ["d", IS_CODE],
    ["[`]", 0],
    [" ", 0],
    ["[~~]", IS_STRIKETHROUGH],
    ["e", IS_STRIKETHROUGH],
    ["[~~]", IS_STRIKETHROUGH],
    [" ", 0],
    ["[[]", 0],
    ["f", IS_UNDERLINE],
    ["[](https://x.y)]", 0],
  ]);
});

it("nests spans and keeps code free of Markdown", () => {
  expect(runs("**a _b_** `**c**`")).toEqual([
    ["[**]", IS_BOLD],
    ["a ", IS_BOLD],
    ["[_]", IS_BOLD | IS_ITALIC],
    ["b", IS_BOLD | IS_ITALIC],
    ["[_]", IS_BOLD | IS_ITALIC],
    ["[**]", IS_BOLD],
    [" ", 0],
    ["[`]", 0],
    ["**c**", IS_CODE],
    ["[`]", 0],
  ]);
});

it("leaves words, tokens, links, and unclosed markers as text", () => {
  for (const line of [
    "snake_case_name and 2 * 3 * 4",
    "<https://x.y/a_b_c|a_b> and https://x.y/a_b_c",
    "**open and `open",
    "** spaced **",
  ]) {
    expect(runs(line).every(([text]) => !String(text).startsWith("["))).toBe(
      true,
    );
  }
});

it("finds list, quote, and fenced code lines", () => {
  const lines = parseMarkdownLines([
    "- one",
    "2. two",
    "> three",
    "```ts",
    "**code**",
    "```",
    "*after*",
  ]);
  expect(lines.map((line) => line.kind)).toEqual([
    "bullet",
    "ordered",
    "quote",
    "fence",
    "code",
    "fence",
    "text",
  ]);
  expect(lines[0]!.segments[0]).toEqual({
    format: 0,
    marker: { edge: "line", span: -1 },
    text: "- ",
  });
  expect(lines[4]!.segments).toEqual([{ format: IS_CODE, text: "**code**" }]);
});

it("styles a span across lines and nested lists in quotes", () => {
  const lines = parseMarkdownLines(["**bold", "still bold**", "> - item"]);
  expect(lines[0]!.segments[0]).toMatchObject({
    marker: { edge: "open" },
    text: "**",
  });
  expect(lines[1]!.segments.at(-1)).toMatchObject({
    marker: { edge: "close", span: lines[0]!.segments[0]!.marker!.span },
    text: "**",
  });
  expect(lines[2]).toMatchObject({
    kind: "bullet",
    segments: [
      { marker: { edge: "line" }, text: "> - " },
      { format: 0, text: "item" },
    ],
  });
});
