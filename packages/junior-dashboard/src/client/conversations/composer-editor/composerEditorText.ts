import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
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

/** Find a person that the composer knows by Slack id. */
export type LookupPerson = (
  slackUserId: string,
) => ComposerMentionPerson | undefined;

/**
 * Read the draft as message text. The editor keeps one paragraph with line
 * breaks, so text without mentions reads back exactly as it was written.
 */
export function $readComposerText(): string {
  return $getRoot().getTextContent();
}

/** Replace the draft with message text. Each `<@U…>` becomes a mention. */
export function $writeComposerText(text: string, lookup: LookupPerson): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const node of composerNodes(text, lookup)) paragraph.append(node);
  root.append(paragraph);
}

/**
 * Turn `<@U…>` in one text node into mentions, for pasted or restored text.
 * A caret in the node keeps its place in the text, so one inside or right
 * after a token lands after its mention.
 */
export function $replaceMentionTokens(
  node: TextNode,
  lookup: LookupPerson,
): void {
  const text = node.getTextContent();
  if (!text.includes("<@")) return;
  const parts = splitMentions(text);
  if (parts.every((part) => "text" in part)) return;
  const selection = $getSelection();
  const caret =
    $isRangeSelection(selection) && selection.anchor.key === node.getKey()
      ? selection.anchor.offset
      : undefined;
  const pieces = composerPieces(parts, lookup);
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

function composerNodes(text: string, lookup: LookupPerson): LexicalNode[] {
  return composerPieces(splitMentions(text), lookup).map(({ node }) => node);
}

// Each node with the length of the message text that it stands for.
function composerPieces(
  parts: ReturnType<typeof splitMentions>,
  lookup: LookupPerson,
): ComposerPiece[] {
  return parts.flatMap((part) =>
    "slackUserId" in part
      ? [
          {
            node: $createComposerMentionNode(
              lookup(part.slackUserId) ?? { slackUserId: part.slackUserId },
            ),
            length: mentionText(part.slackUserId).length,
          },
        ]
      : plainTextNodes(part.text),
  );
}

// Plain text mode writes a new line as a line break and a tab as a tab node.
function plainTextNodes(text: string): ComposerPiece[] {
  return text
    .split(/(\n|\t)/)
    .filter(Boolean)
    .map((piece) => ({
      node:
        piece === "\n"
          ? $createLineBreakNode()
          : piece === "\t"
            ? $createTabNode()
            : $createTextNode(piece),
      length: piece.length,
    }));
}
