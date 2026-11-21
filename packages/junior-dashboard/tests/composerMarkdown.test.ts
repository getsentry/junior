import { $dfs } from "@lexical/utils";
import { createEditor } from "lexical";
import { expect, it } from "vitest";

import { ComposerMentionNode } from "../src/client/conversations/composer-editor/ComposerMentionNode";
import {
  $readComposerText,
  $writeComposerText,
} from "../src/client/conversations/composer-editor/composerEditorText";
import { COMPOSER_MARKDOWN_NODES } from "../src/client/conversations/composer-editor/composerMarkdown";
import { ComposerReferenceNode } from "../src/client/conversations/composer-editor/ComposerReferenceNode";

// Write message text into the editor, then read it back: what a restored
// queued message sends.
function roundTrip(text: string) {
  const editor = createEditor({
    nodes: [
      ComposerMentionNode,
      ComposerReferenceNode,
      ...COMPOSER_MARKDOWN_NODES,
    ],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () =>
      $writeComposerText(text, {
        origin: "https://junior.example",
        person: (slackUserId) => ({ slackUserId }),
        reference: () => undefined,
      }),
    { discrete: true },
  );
  return editor.getEditorState().read(() => ({
    chips: $dfs().filter(({ node }) => node instanceof ComposerReferenceNode)
      .length,
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
  expect(roundTrip("hi <@U1>")).toEqual({
    chips: 0,
    mentions: 1,
    text: "hi <@U1>",
  });
  expect(roundTrip("`<@U1>`")).toEqual({
    chips: 0,
    mentions: 0,
    text: "`<@U1>`",
  });
  expect(roundTrip("```\n<@U1>\n```")).toEqual({
    chips: 0,
    mentions: 0,
    text: "```\n<@U1>\n```",
  });
});

it("turns reference tokens outside code into chips", () => {
  const pr =
    "<https://github.com/getsentry/junior/pull/3846|getsentry/junior#3846>";
  expect(roundTrip(`**see** ${pr} in <#C123|general>`)).toEqual({
    chips: 2,
    mentions: 0,
    text: `**see** ${pr} in <#C123|general>`,
  });
  expect(roundTrip(`\`${pr}\``)).toEqual({
    chips: 0,
    mentions: 0,
    text: `\`${pr}\``,
  });
});
