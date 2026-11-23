import { expect, it } from "vitest";

import {
  listEnter,
  orderedListNumbers,
} from "../src/client/conversations/composer-editor/composerMarkdownLists";
import { parseMarkdownLines } from "../src/client/conversations/composer-editor/composerMarkdownSyntax";

// The number each line renders with, or undefined.
function numbers(lines: string[]) {
  return orderedListNumbers(
    parseMarkdownLines(lines).map(({ kind }, index) => ({
      kind,
      text: lines[index]!,
    })),
  );
}

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("continues an ordered list with the next number and delimiter", () => {
  expect(listEnter("1. Item one")).toEqual({
    kind: "continue",
    marker: "2. ",
  });
  expect(listEnter("9) Item")).toEqual({ kind: "continue", marker: "10) " });
  // After the number that the item renders with, so the source stays in
  // order as the preview numbers it.
  expect(listEnter("1. Item three", 3)).toEqual({
    kind: "continue",
    marker: "4. ",
  });
  expect(listEnter("  3. Nested")).toEqual({
    kind: "continue",
    marker: "  4. ",
  });
});

it("continues a bullet list with the same bullet", () => {
  expect(listEnter("- a")).toEqual({ kind: "continue", marker: "- " });
  expect(listEnter("  * b")).toEqual({ kind: "continue", marker: "  * " });
});

it("ends a list on an item with only its marker", () => {
  expect(listEnter("2. ")).toEqual({ kind: "end" });
  expect(listEnter("- ")).toEqual({ kind: "end" });
  expect(listEnter("  -   ")).toEqual({ kind: "end" });
});

it("leaves lines that are not list items alone", () => {
  expect(listEnter("plain text")).toBeUndefined();
  expect(listEnter("1.5 apples")).toBeUndefined();
  expect(listEnter("-not a bullet")).toBeUndefined();
});

it("numbers an ordered list from its first item, as CommonMark renders it", () => {
  expect(numbers(["1. a", "1. b", "1. c"])).toEqual([1, 2, 3]);
  expect(numbers(["1. a", "2. b", "3. c"])).toEqual([1, 2, 3]);
  expect(numbers(["3) a", "1) b"])).toEqual([3, 4]);
});

it("numbers nested lists on their own and resumes the outer list", () => {
  expect(numbers(["1. a", "   1. x", "   1. y", "1. b"])).toEqual([1, 1, 2, 2]);
  expect(numbers(["1. a", "  - x", "1. b"])).toEqual([1, undefined, 2]);
});

it("keeps a list across blank and continuation lines", () => {
  expect(numbers(["1. a", "", "1. b", "lazy line", "1. c"])).toEqual([
    1,
    undefined,
    2,
    undefined,
    3,
  ]);
});

it("starts a new list after a break", () => {
  expect(numbers(["1. a", "", "text", "1. b"])).toEqual([
    1,
    undefined,
    undefined,
    1,
  ]);
  expect(numbers(["1. a", "- x", "1. b"])).toEqual([1, undefined, 1]);
  expect(numbers(["1. a", "1) b"])).toEqual([1, 1]);
  expect(numbers(["1. a", "```", "1. code", "```", "1. b"])).toEqual([
    1,
    undefined,
    undefined,
    undefined,
    1,
  ]);
});
