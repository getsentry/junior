import { $isCodeNode, CodeHighlightNode, CodeNode } from "@lexical/code-core";
import { LinkNode } from "@lexical/link";
import { $isListItemNode, ListItemNode, ListNode } from "@lexical/list";
import {
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CODE,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  $convertToMarkdownString,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";
import { QuoteNode } from "@lexical/rich-text";
import {
  $isTextNode,
  type EditorThemeClasses,
  type LexicalNode,
} from "lexical";

// The Markdown export escapes `*`, `_`, `` ` ``, and `~` in text. Message
// text keeps them as typed, so `snake_case` reaches the agent unchanged:
// text goes to the export with each one swapped for a private-use
// character, and `$exportComposerMarkdown` swaps them back.
const LITERALS = "*_`~";
const FIRST_PRIVATE = 0xe000;

const LITERAL_TEXT: TextMatchTransformer = {
  dependencies: [],
  export: (node, _exportChildren, exportFormat) =>
    $isTextNode(node) && !node.hasFormat("code")
      ? exportFormat(
          node,
          node
            .getTextContent()
            .replace(/[*_`~]/g, (char) =>
              String.fromCharCode(FIRST_PRIVATE + LITERALS.indexOf(char)),
            ),
        )
      : null,
  // Export only. Never matches text.
  regExp: /(?!)/,
  type: "text-match",
};

/**
 * The Markdown that the composer renders as you type and writes back to
 * message text. No headings: chat messages rarely need them.
 */
export const COMPOSER_MARKDOWN: Transformer[] = [
  CODE,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  STRIKETHROUGH,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  LITERAL_TEXT,
];

/** The draft as Markdown, one line for each paragraph. */
export function $exportComposerMarkdown(): string {
  return $convertToMarkdownString(COMPOSER_MARKDOWN, undefined, true).replace(
    /[\uE000-\uE003]/g,
    (char) => LITERALS[char.charCodeAt(0) - FIRST_PRIVATE] ?? char,
  );
}

/** The nodes that `COMPOSER_MARKDOWN` makes. */
export const COMPOSER_MARKDOWN_NODES = [
  CodeHighlightNode,
  CodeNode,
  LinkNode,
  ListItemNode,
  ListNode,
  QuoteNode,
];

/** True when the node is code, where `$` and `@` are only text. */
export function $isInCode(node: LexicalNode): boolean {
  if ($isTextNode(node) && node.hasFormat("code")) return true;
  return [node, ...node.getParents()].some($isCodeNode);
}

/** True when the node is in a code block or a list, where Enter adds a line. */
export function $isInMultilineBlock(node: LexicalNode): boolean {
  return [node, ...node.getParents()].some(
    (block) => $isCodeNode(block) || $isListItemNode(block),
  );
}

/** Classes for rendered Markdown, close to how the transcript shows it. */
export const COMPOSER_THEME: EditorThemeClasses = {
  code: "my-1 block whitespace-pre-wrap rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2 font-mono text-[0.9em]",
  link: "text-dashboard-accent-text underline underline-offset-2",
  list: {
    listitem: "min-w-0",
    nested: { listitem: "list-none" },
    ol: "m-0 list-outside list-decimal pl-6 marker:text-dashboard-text-muted",
    ul: "m-0 list-outside list-disc pl-6 marker:text-dashboard-text-muted",
  },
  paragraph: "m-0",
  quote:
    "m-0 border-l-2 border-dashboard-border pl-3 text-dashboard-text-muted",
  text: {
    bold: "font-semibold",
    code: "rounded-[0.25rem] bg-dashboard-fill-strong px-1 py-0.5 font-mono text-[0.9em]",
    italic: "italic",
    strikethrough: "line-through text-dashboard-text-muted",
  },
};
