import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
} from "lexical";

import { mentionText } from "../composerMentionToken";
import {
  referenceText,
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
 * Replace the draft with message text, as it is. `$styleComposerDraft`
 * then styles its Markdown and turns its tokens into chips.
 */
export function $writeComposerText(text: string): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const { node } of plainTextNodes(text)) paragraph.append(node);
  root.append(paragraph);
}

type ComposerPiece = { node: LexicalNode; length: number };

/** Each node of message text parts, with the length of the text it stands for. */
export function $composerPieces(
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
