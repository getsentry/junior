import {
  $convertFromMarkdownString,
  $generateNodesFromMarkdownString,
} from "@lexical/markdown";
import { $dfs } from "@lexical/utils";
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
  type TextNode,
} from "lexical";

import { mentionText } from "../composerMentionToken";
import {
  referenceText,
  splitComposerText,
  type ComposerReference,
  type ComposerTextPart,
} from "../composerReferences";
import {
  $createComposerMentionNode,
  type ComposerMentionPerson,
} from "./ComposerMentionNode";
import {
  $exportComposerMarkdown,
  $isInCode,
  COMPOSER_MARKDOWN,
} from "./composerMarkdown";
import { $createComposerReferenceNode } from "./ComposerReferenceNode";

/** What the composer knows about the people and references in its text. */
export type ComposerLookup = {
  /** The origin of the dashboard, whose Conversation links are references. */
  origin: string;
  /** A person that the composer knows by Slack id. */
  person(slackUserId: string): ComposerMentionPerson | undefined;
  /**
   * A reference that the composer inserted, by its message text. It knows
   * more than the text: a Task, or a state.
   */
  reference(text: string): ComposerReference | undefined;
};

/**
 * Read the draft as message text: Markdown, with each mention as `<@U…>`.
 * Each paragraph is one line, so text without Markdown reads back as it
 * was written.
 */
export function $readComposerText(): string {
  return $exportComposerMarkdown();
}

/**
 * Replace the draft with message text. Its Markdown renders, each `<@U…>`
 * becomes a mention, and each reference token of `splitComposerText`
 * becomes a chip.
 */
export function $writeComposerText(text: string, lookup: ComposerLookup): void {
  $convertFromMarkdownString(text, COMPOSER_MARKDOWN, undefined, true);
  for (const { node } of $dfs()) {
    if ($isTextNode(node)) $replaceComposerTokens(node, lookup);
  }
}

/** Insert pasted text at the selection, with its Markdown rendered outside code. */
export function $insertComposerMarkdown(text: string): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  if ($isInCode(selection.anchor.getNode())) {
    selection.insertRawText(text);
    return;
  }
  selection.insertNodes(
    $generateNodesFromMarkdownString(text, COMPOSER_MARKDOWN, true),
  );
}

/**
 * Turn the mention and reference tokens in one text node into chips, for
 * pasted or restored text. Code keeps the tokens as text. A caret in the
 * node keeps its place in the text, so one inside or right after a token
 * lands after its chip.
 */
export function $replaceComposerTokens(
  node: TextNode,
  lookup: ComposerLookup,
): void {
  const text = node.getTextContent();
  if (!text.includes("<") || $isInCode(node)) return;
  const parts = splitComposerText(text, lookup.origin);
  if (parts.every((part) => "text" in part)) return;
  const selection = $getSelection();
  const caret =
    $isRangeSelection(selection) && selection.anchor.key === node.getKey()
      ? selection.anchor.offset
      : undefined;
  const format = node.getFormat();
  const pieces = parts.map((part) => composerPiece(part, lookup, format));
  let last: LexicalNode = node;
  for (const piece of pieces) {
    last.insertAfter(piece.node);
    last = piece.node;
  }
  node.remove();
  if (caret !== undefined) $placeCaret(pieces, caret);
}

type ComposerPiece = { node: LexicalNode; length: number };

// Put the caret at `caret` characters into the replaced text.
function $placeCaret(pieces: ComposerPiece[], caret: number): void {
  let start = 0;
  for (const { node, length } of pieces) {
    const end = start + length;
    if (caret <= end) {
      if ($isTextNode(node)) node.select(caret - start, caret - start);
      else if (caret === start) node.selectPrevious();
      else node.selectNext(0, 0);
      return;
    }
    start = end;
  }
}

// One part of the text as a node, with the length of the text it stands for.
function composerPiece(
  part: ComposerTextPart,
  lookup: ComposerLookup,
  format: number,
): ComposerPiece {
  if ("text" in part) {
    return {
      node: $createTextNode(part.text).setFormat(format),
      length: part.text.length,
    };
  }
  if ("slackUserId" in part) {
    return {
      node: $createComposerMentionNode(
        lookup.person(part.slackUserId) ?? { slackUserId: part.slackUserId },
      ),
      length: mentionText(part.slackUserId).length,
    };
  }
  const text = referenceText(part.reference);
  return {
    node: $createComposerReferenceNode(
      lookup.reference(text) ?? part.reference,
    ),
    length: text.length,
  };
}
