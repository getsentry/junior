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
 * Read the draft as message text. The editor keeps one paragraph with line
 * breaks, so text without mentions reads back exactly as it was written.
 */
export function $readComposerText(): string {
  return $getRoot().getTextContent();
}

/**
 * Replace the draft with message text. Each `<@U…>` becomes a mention, and
 * each reference token of `splitComposerText` becomes a chip.
 */
export function $writeComposerText(text: string, lookup: ComposerLookup): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const node of composerNodes(text, lookup)) paragraph.append(node);
  root.append(paragraph);
}

/**
 * Turn the mention and reference tokens in one text node into chips, for
 * pasted or restored text. A caret in the node keeps its place in the
 * text, so one inside or right after a token lands after its chip.
 */
export function $replaceComposerTokens(
  node: TextNode,
  lookup: ComposerLookup,
): void {
  const text = node.getTextContent();
  if (!text.includes("<")) return;
  const parts = splitComposerText(text, lookup.origin);
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

function composerNodes(text: string, lookup: ComposerLookup): LexicalNode[] {
  return composerPieces(splitComposerText(text, lookup.origin), lookup).map(
    ({ node }) => node,
  );
}

// Each node with the length of the message text that it stands for.
function composerPieces(
  parts: ComposerTextPart[],
  lookup: ComposerLookup,
): ComposerPiece[] {
  return parts.flatMap((part): ComposerPiece[] => {
    if ("text" in part) return plainTextNodes(part.text);
    if ("slackUserId" in part) {
      return [
        {
          node: $createComposerMentionNode(
            lookup.person(part.slackUserId) ?? {
              slackUserId: part.slackUserId,
            },
          ),
          length: mentionText(part.slackUserId).length,
        },
      ];
    }
    const text = referenceText(part.reference);
    return [
      {
        node: $createComposerReferenceNode(
          lookup.reference(text) ?? part.reference,
        ),
        length: text.length,
      },
    ];
  });
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
