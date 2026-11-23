import {
  markdownNodes,
  markdownPlainText,
  markdownText,
  parseMarkdown,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";

const SAMPLE = [
  "## Deploy `api_server`",
  "",
  "> - **Approve** it in [the console](https://example.com)",
  "",
  "```sh",
  "deploy --force",
  "```",
  "",
  "![graph](https://example.com/graph.png) <b>new</b> ~~old~~",
].join("\n");

describe("Markdown helpers", () => {
  it("reads plain text without Markdown syntax", () => {
    expect(markdownPlainText(SAMPLE)).toBe(
      "Deploy api_server Approve it in the console deploy --force graph <b>new</b> old",
    );
  });

  it("keeps only prose when asked", () => {
    expect(markdownPlainText(SAMPLE, { proseOnly: true })).toBe(
      "Deploy api_server Approve it in the console new old",
    );
  });

  it("finds nodes of a type with their source offsets", () => {
    const codes = markdownNodes(parseMarkdown(SAMPLE), ["code", "inlineCode"]);
    expect(
      codes.map(({ position }) =>
        SAMPLE.slice(position?.start.offset, position?.end.offset),
      ),
    ).toEqual(["`api_server`", "```sh\ndeploy --force\n```"]);
  });

  it("joins inline parts with no space", () => {
    const [paragraph] = parseMarkdown("a**b**_c_").children;
    expect(paragraph && markdownText(paragraph)).toBe("abc");
  });
});
