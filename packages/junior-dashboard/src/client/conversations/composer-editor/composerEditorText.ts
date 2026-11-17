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

import { splitMentions } from "../composerMentionToken";
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
 * The caret moves after the last part when it was in the node.
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
  const hadCaret =
    $isRangeSelection(selection) && selection.anchor.key === node.getKey();
  const nodes = composerNodes(text, lookup);
  let last: LexicalNode = node;
  for (const next of nodes) {
    last.insertAfter(next);
    last = next;
  }
  node.remove();
  if (!hadCaret) return;
  if ($isTextNode(last)) last.select();
  else last.selectNext(0, 0);
}

function composerNodes(text: string, lookup: LookupPerson): LexicalNode[] {
  return splitMentions(text).flatMap((part) =>
    "slackUserId" in part
      ? [
          $createComposerMentionNode(
            lookup(part.slackUserId) ?? { slackUserId: part.slackUserId },
          ),
        ]
      : plainTextNodes(part.text),
  );
}

// Plain text mode writes a new line as a line break and a tab as a tab node.
function plainTextNodes(text: string): LexicalNode[] {
  return text
    .split(/(\n|\t)/)
    .filter(Boolean)
    .map((piece) =>
      piece === "\n"
        ? $createLineBreakNode()
        : piece === "\t"
          ? $createTabNode()
          : $createTextNode(piece),
    );
}
