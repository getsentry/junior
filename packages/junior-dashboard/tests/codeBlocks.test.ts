import { describe, expect, it } from "vitest";

import { parseMarkdownBlocks } from "../src/client/display-text/codeBlocks";

describe("transcript blocks", () => {
  it("keeps prose as markdown and preserves fenced languages", () => {
    expect(
      parseMarkdownBlocks("The function returns a const value.")[0],
    ).toMatchObject({
      fenced: false,
      language: "markdown",
    });
    expect(parseMarkdownBlocks('```json\n{"ok":true}\n```')[0]).toMatchObject({
      fenced: true,
      language: "json",
    });
    expect(parseMarkdownBlocks("```xml\n<root />\n```")[0]).toMatchObject({
      fenced: true,
      language: "xml",
    });
  });

  it.each([
    ["javascript:(()=>{alert(1)})()", "tsx"],
    ["const total = items.length;", "tsx"],
    ["export class Store {}", "tsx"],
    ["export { handler };", "tsx"],
    ["export * from './api';", "tsx"],
    ["export async function load() {}", "tsx"],
    ["export API_URL=https://example.com", "shellscript"],
    ["export var=1", "shellscript"],
    ["def handler(event):\n    return event", "python"],
    ["class Store(Base):\n    pass", "python"],
    ["class Empty: pass", "python"],
    ["class Store { size: number }", "markdown"],
    ["pnpm install --frozen-lockfile", "shellscript"],
    ["$ git status", "shellscript"],
    ['{"ok":true}', "json"],
    ["Thanks for the report. I will look at it today.", "markdown"],
  ])("guesses the language of untagged fence %j", (code, language) => {
    expect(parseMarkdownBlocks(`\`\`\`\n${code}\n\`\`\``)[0]).toMatchObject({
      fenced: true,
      language,
    });
  });

  it.each([
    ["```c++\nint main() {}\n```", "c++"],
    ['```js title="x.js"\nconst a = 1;\n```', "javascript"],
    ["```ts \nconst a = 1;\n```", "ts"],
  ])("reads the language from the fence info string %j", (text, language) => {
    expect(
      parseMarkdownBlocks(text).find((block) => block.fenced),
    ).toMatchObject({ language });
  });

  it("removes the list indent from a fence in a list item", () => {
    expect(
      parseMarkdownBlocks(
        "1. Run it:\n   ```sh\n   pnpm test\n     --watch\n   ```",
      ),
    ).toMatchObject([
      { fenced: false },
      { code: "pnpm test\n  --watch\n", fenced: true, language: "shellscript" },
    ]);
  });

  it("does not open a fence in the middle of a line", () => {
    expect(
      parseMarkdownBlocks("Wrap code in ``` fences like this:\nfoo ```"),
    ).toMatchObject([{ fenced: false }]);
  });

  it("keeps an explicit text fence plain", () => {
    expect(
      parseMarkdownBlocks("```text\nconst total = 1;\n```")[0],
    ).toMatchObject({ language: "markdown" });
  });
});
