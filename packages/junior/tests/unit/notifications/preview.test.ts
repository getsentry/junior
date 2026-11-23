import { describe, expect, it } from "vitest";
import { notificationPreview } from "@/chat/notifications/preview";

describe("notificationPreview", () => {
  it("keeps the text of Markdown and drops its syntax", () => {
    expect(
      notificationPreview(
        [
          "## Deploy of `api_server`",
          "",
          "**Approve** it in [the console](https://example.com), or run:",
          "",
          "```sh",
          "deploy --force",
          "```",
          "",
          "- keep my_var as is",
          "- a literal \\*star\\* stays",
          "",
          "![graph](https://example.com/graph.png)",
        ].join("\n"),
      ),
    ).toBe(
      "Deploy of api_server Approve it in the console, or run: keep my_var as is a literal *star* stays",
    );
  });

  it("cuts a long text to one short line", () => {
    const preview = notificationPreview("word ".repeat(100));
    expect(preview).toHaveLength(180);
    expect(preview.endsWith("…")).toBe(true);
  });
});
