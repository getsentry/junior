import { $dfs } from "@lexical/utils";
import { createEditor } from "lexical";
import { expect, it } from "vitest";

import { ComposerMentionNode } from "../src/client/conversations/composer-editor/ComposerMentionNode";
import {
  $readComposerText,
  $writeComposerText,
} from "../src/client/conversations/composer-editor/composerEditorText";
import { COMPOSER_MARKDOWN_NODES } from "../src/client/conversations/composer-editor/composerMarkdown";

// Write message text into the editor, then read it back: what a restored
// queued message sends.
function roundTrip(text: string) {
  const editor = createEditor({
    nodes: [ComposerMentionNode, ...COMPOSER_MARKDOWN_NODES],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () => $writeComposerText(text, (slackUserId) => ({ slackUserId })),
    { discrete: true },
  );
  return editor.getEditorState().read(() => ({
    mentions: $dfs().filter(({ node }) => node instanceof ComposerMentionNode)
      .length,
    text: $readComposerText(),
  }));
}

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("reads message text back as the same Markdown", () => {
  for (const text of [
    "plain\ntwo lines\n\nand a gap",
    "**bold** *italic* `code` ~~strike~~ [link](https://sentry.io)",
    "> quoted",
    "- one\n- two",
    "1. one\n2. two",
    "```\nconst a = 1;\n```",
    "$skill-name do it <@U123>",
    // Text keeps Markdown characters as typed, without escapes.
    "snake_case_name, 2 * 3, **unclosed, ~/path",
  ]) {
    expect(roundTrip(text).text).toBe(text);
  }
});

it("keeps mention tokens in code as text", () => {
  expect(roundTrip("hi <@U1>")).toEqual({ mentions: 1, text: "hi <@U1>" });
  expect(roundTrip("`<@U1>`")).toEqual({ mentions: 0, text: "`<@U1>`" });
  expect(roundTrip("```\n<@U1>\n```")).toEqual({
    mentions: 0,
    text: "```\n<@U1>\n```",
  });
});
