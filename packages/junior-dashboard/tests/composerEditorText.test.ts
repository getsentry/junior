import { $getRoot, $isElementNode, createEditor } from "lexical";
import { expect, it } from "vitest";

import { ComposerMentionNode } from "../src/client/conversations/composer-editor/ComposerMentionNode";
import { ComposerReferenceNode } from "../src/client/conversations/composer-editor/ComposerReferenceNode";
import {
  $readComposerText,
  $writeComposerText,
  type ComposerLookup,
} from "../src/client/conversations/composer-editor/composerEditorText";

const ORIGIN = "https://junior.example.com";
const lookup: ComposerLookup = {
  origin: ORIGIN,
  person: () => undefined,
  reference: () => undefined,
};

// Write the text into a headless editor and read it back, with the types of
// the nodes that it became.
function roundTrip(text: string) {
  const editor = createEditor({
    nodes: [ComposerMentionNode, ComposerReferenceNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(() => $writeComposerText(text, lookup), { discrete: true });
  return editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChild();
    const nodes = $isElementNode(paragraph) ? paragraph.getChildren() : [];
    return {
      text: $readComposerText(),
      chips: nodes.flatMap((node) =>
        node instanceof ComposerMentionNode ||
        node instanceof ComposerReferenceNode
          ? [node.getTextContent()]
          : [],
      ),
    };
  });
}

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("reads text without references back exactly", () => {
  const text =
    "Plain text\n\twith a tab, # heading, a#b, C#, <https://example.com|a page> and <#C1>";
  expect(roundTrip(text)).toEqual({ text, chips: [] });
});

it("reads mentions and references back as chips with the same text", () => {
  const text = `ask <@U789> about <${ORIGIN}/conversations/a|Checkout triage>, <https://github.com/getsentry/junior/pull/3842|getsentry/junior#3842> in <#C123|proj-junior>`;
  expect(roundTrip(text)).toEqual({
    text,
    chips: [
      "<@U789>",
      `<${ORIGIN}/conversations/a|Checkout triage>`,
      "<https://github.com/getsentry/junior/pull/3842|getsentry/junior#3842>",
      "<#C123|proj-junior>",
    ],
  });
});
