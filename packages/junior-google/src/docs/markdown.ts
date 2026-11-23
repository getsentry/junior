/**
 * Convert a small Markdown subset to Google Docs text and styles.
 *
 * The Docs API has no Markdown import for an existing Doc, so the edit tools
 * insert plain text and then apply styles by index. Supported: ATX headings,
 * paragraphs, bullet and numbered lists (nested by indent), fenced code,
 * bold, italic, inline code, and http, https, or mailto links. Other syntax,
 * such as tables and images, stays as plain text.
 */

import { type MarkdownNode, parseMarkdown } from "@sentry/junior-plugin-api";

/** Docs named paragraph styles that the converter uses. */
type DocParagraphStyle =
  | "NORMAL_TEXT"
  | "HEADING_1"
  | "HEADING_2"
  | "HEADING_3"
  | "HEADING_4"
  | "HEADING_5"
  | "HEADING_6";

/** A range of the converted text, in UTF-16 offsets as Docs counts them. */
interface Range {
  end: number;
  start: number;
}

interface DocTextStyle extends Range {
  bold?: true;
  code?: true;
  italic?: true;
  link?: string;
}

export interface ConvertedMarkdown {
  /** One list block each. Leading tabs in the text set the nesting level. */
  lists: Array<Range & { ordered: boolean }>;
  paragraphs: Array<Range & { style: DocParagraphStyle }>;
  /** Paragraphs joined by `\n`, with no final newline. */
  text: string;
  textStyles: DocTextStyle[];
}

type InlineStyle = Omit<DocTextStyle, "start" | "end">;

interface Run {
  style: InlineStyle;
  text: string;
}

const SAFE_LINK_PREFIXES = ["https://", "http://", "mailto:"];
// Docs drops these characters on insert, which would shift every later
// index, so the converter drops them first.
const DROPPED_CHARACTERS =
  // oxlint-disable-next-line no-control-regex -- Docs drops these characters.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/gu;
// Docs supports nine list levels.
const MAX_LIST_LEVEL = 8;

interface Block {
  /** Nesting level of a list item. */
  level?: number;
  ordered?: boolean;
  runs: Run[];
  style: DocParagraphStyle;
}

// The Markdown source of a node, for syntax that Docs cannot style. Markdown
// joins wrapped lines, so line breaks become spaces.
function sourceText(node: MarkdownNode, markdown: string): string {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? start;
  return markdown.slice(start, end).replaceAll("\n", " ");
}

function isSafeLink(url: string): boolean {
  const lower = url.toLowerCase();
  return SAFE_LINK_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// The style that each emphasis node adds to its text.
const EMPHASIS_STYLES: Partial<Record<MarkdownNode["type"], InlineStyle>> = {
  emphasis: { italic: true },
  strong: { bold: true },
};

/** Read the inline children of a node into styled runs. */
function inlineRuns(
  nodes: readonly MarkdownNode[],
  markdown: string,
  style: InlineStyle = {},
): Run[] {
  return nodes.flatMap((node): Run[] => {
    if (node.type === "text") {
      return [{ style, text: node.value.replaceAll("\n", " ") }];
    }
    if (node.type === "break") return [{ style, text: " " }];
    if (node.type === "inlineCode") {
      return [{ style: { ...style, code: true }, text: node.value }];
    }
    if (node.type === "link" && isSafeLink(node.url)) {
      return inlineRuns(node.children, markdown, { ...style, link: node.url });
    }
    const added = EMPHASIS_STYLES[node.type];
    if (added && "children" in node) {
      return inlineRuns(node.children, markdown, { ...style, ...added });
    }
    return [{ style, text: sourceText(node, markdown) }];
  });
}

// Blocks with no text in a Doc.
const DROPPED_BLOCKS = new Set<MarkdownNode["type"]>([
  "definition",
  "thematicBreak",
]);

/** Read Markdown blocks into Docs paragraphs. */
function parseBlocks(input: string): Block[] {
  const markdown = input
    .replace(/\r\n?/g, "\n")
    .replace(DROPPED_CHARACTERS, "");
  const blocks: Block[] = [];
  const paragraph = (runs: Run[], style: DocParagraphStyle = "NORMAL_TEXT") =>
    blocks.push({ runs, style });
  const visit = (nodes: readonly MarkdownNode[], level?: number) => {
    for (const node of nodes) {
      if (node.type === "heading") {
        paragraph(inlineRuns(node.children, markdown), `HEADING_${node.depth}`);
      } else if (node.type === "paragraph") {
        paragraph(inlineRuns(node.children, markdown));
      } else if (node.type === "code") {
        for (const line of node.value.split("\n")) {
          paragraph(line ? [{ style: { code: true }, text: line }] : []);
        }
      } else if (node.type === "blockquote") {
        visit(node.children);
      } else if (node.type === "list") {
        const itemLevel = Math.min(
          level === undefined ? 0 : level + 1,
          MAX_LIST_LEVEL,
        );
        for (const item of node.children) {
          // The item's paragraphs make one list paragraph. A nested list or
          // a code block follows it.
          const block: Block = {
            level: itemLevel,
            ordered: node.ordered === true,
            runs: [],
            style: "NORMAL_TEXT",
          };
          blocks.push(block);
          for (const child of item.children) {
            if (child.type !== "paragraph") {
              visit([child], itemLevel);
              continue;
            }
            if (block.runs.length) block.runs.push({ style: {}, text: " " });
            block.runs.push(...inlineRuns(child.children, markdown));
          }
          // Docs has no checkbox here, so a task item keeps its Markdown box.
          if (typeof item.checked === "boolean") {
            block.runs.unshift({
              style: {},
              text: item.checked ? "[x] " : "[ ] ",
            });
          }
        }
      } else if (!DROPPED_BLOCKS.has(node.type)) {
        paragraph([{ style: {}, text: sourceText(node, markdown) }]);
      }
    }
  };
  visit(parseMarkdown(markdown).children);
  return blocks;
}

/**
 * Convert Markdown to Docs text, paragraph styles, text styles, and list
 * blocks. Offsets are relative to the start of the returned text.
 */
export function convertMarkdown(markdown: string): ConvertedMarkdown {
  const result: ConvertedMarkdown = {
    lists: [],
    paragraphs: [],
    text: "",
    textStyles: [],
  };
  // Empty blocks at either end, such as a blank line before a closing code
  // fence, would add a leading or final newline. The edit ranges assume
  // neither.
  const blocks = parseBlocks(markdown);
  const hasText = (block: Block) => block.runs.some((run) => run.text);
  const first = blocks.findIndex(hasText);
  const last = blocks.length - 1 - [...blocks].reverse().findIndex(hasText);
  let previous: Block | undefined;
  for (const block of first < 0 ? [] : blocks.slice(first, last + 1)) {
    if (previous) result.text += "\n";
    const start = result.text.length;
    if (block.level !== undefined) {
      result.text += "\t".repeat(block.level);
    }
    for (const run of block.runs) {
      const runStart = result.text.length;
      result.text += run.text;
      if (Object.keys(run.style).length && run.text) {
        result.textStyles.push({
          ...run.style,
          end: result.text.length,
          start: runStart,
        });
      }
    }
    const end = result.text.length;
    const lastParagraph = result.paragraphs.at(-1);
    if (lastParagraph?.style === block.style) {
      lastParagraph.end = end;
    } else {
      result.paragraphs.push({ end, start, style: block.style });
    }
    if (block.level !== undefined) {
      const lastList = result.lists.at(-1);
      if (previous?.level !== undefined && lastList) {
        lastList.end = end;
      } else {
        result.lists.push({ end, ordered: block.ordered === true, start });
      }
    }
    previous = block;
  }
  return result;
}
