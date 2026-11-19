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

import { splitMentions } from "../composerMentionToken";
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
 * Code keeps the token as text. The caret moves after the last part when
 * it was in the node.
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
  const hadCaret =
    $isRangeSelection(selection) && selection.anchor.key === node.getKey();
  const format = node.getFormat();
  let last: LexicalNode = node;
  for (const part of parts) {
    const next =
      "slackUserId" in part
        ? $createComposerMentionNode(
            lookup(part.slackUserId) ?? { slackUserId: part.slackUserId },
          )
        : $createTextNode(part.text).setFormat(format);
    last.insertAfter(next);
    last = next;
  }
  node.remove();
  if (!hadCaret) return;
  if ($isTextNode(last)) last.select();
  else last.selectNext(0, 0);
}
