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

import { mentionText, splitMentions } from "../composerMentionToken";
import {
  $createComposerMentionNode,
  type ComposerMentionPerson,
} from "./ComposerMentionNode";
import {
  $exportComposerMarkdown,
  $isInCode,
  COMPOSER_MARKDOWN,
} from "./composerMarkdown";

/** Find a person that the composer knows by Slack id. */
export type LookupPerson = (
  slackUserId: string,
) => ComposerMentionPerson | undefined;

/**
 * Read the draft as message text: Markdown, with each mention as `<@U…>`.
 * Each paragraph is one line, so text without Markdown reads back as it
 * was written.
 */
export function $readComposerText(): string {
  return $exportComposerMarkdown();
}

/** Replace the draft with message text. Each `<@U…>` becomes a mention. */
export function $writeComposerText(text: string, lookup: LookupPerson): void {
  $convertFromMarkdownString(text, COMPOSER_MARKDOWN, undefined, true);
  for (const { node } of $dfs()) {
    if ($isTextNode(node)) $replaceMentionTokens(node, lookup);
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
 * Turn `<@U…>` in one text node into mentions, for pasted or restored text.
 * Code keeps the token as text. A caret in the node keeps its place in the
 * text, so one inside or right after a token lands after its mention.
 */
export function $replaceMentionTokens(
  node: TextNode,
  lookup: LookupPerson,
): void {
  const text = node.getTextContent();
  if (!text.includes("<@") || $isInCode(node)) return;
  const parts = splitMentions(text);
  if (parts.every((part) => "text" in part)) return;
  const selection = $getSelection();
  const caret =
    $isRangeSelection(selection) && selection.anchor.key === node.getKey()
      ? selection.anchor.offset
      : undefined;
  const format = node.getFormat();
  const pieces: ComposerPiece[] = parts.map((part) =>
    "slackUserId" in part
      ? {
          node: $createComposerMentionNode(
            lookup(part.slackUserId) ?? { slackUserId: part.slackUserId },
          ),
          length: mentionText(part.slackUserId).length,
        }
      : {
          node: $createTextNode(part.text).setFormat(format),
          length: part.text.length,
        },
  );
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
