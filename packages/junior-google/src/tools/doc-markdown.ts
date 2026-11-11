/**
 * Convert a small Markdown subset to Google Docs text and styles.
 *
 * The Docs API has no Markdown import for an existing Doc, so the edit tools
 * insert plain text and then apply styles by index. Supported: ATX headings,
 * paragraphs, bullet and numbered lists (nested by indent), fenced code,
 * bold, italic, inline code, and http, https, or mailto links. Other syntax,
 * such as tables and images, stays as plain text.
 */

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

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const ESCAPABLE = /[\\`*_[\]()#+\-.!>|~]/;
// Docs drops these characters on insert, which would shift every later
// index, so the converter drops them first.
const DROPPED_CHARACTERS =
  // oxlint-disable-next-line no-control-regex -- Docs drops these characters.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/gu;

/** Parse inline Markdown into styled runs. */
function parseInline(text: string, style: InlineStyle = {}): Run[] {
  const runs: Run[] = [];
  let plain = "";
  const flush = () => {
    if (plain) runs.push({ style, text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const char = text[i]!;
    if (char === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        runs.push({
          style: { ...style, code: true },
          text: text.slice(i + 1, close),
        });
        i = close + 1;
        continue;
      }
    }
    const link = char === "[" ? LINK.exec(rest) : null;
    if (link && SAFE_LINK.test(link[2]!)) {
      flush();
      runs.push(...parseInline(link[1]!, { ...style, link: link[2]! }));
      i += link[0].length;
      continue;
    }
    const bold = /^(\*\*|__)(?!\s)(.+?)(?<!\s)\1/.exec(rest);
    if (bold && (char === "*" || !/\w/.test(text[i - 1] ?? ""))) {
      flush();
      runs.push(...parseInline(bold[2]!, { ...style, bold: true }));
      i += bold[0].length;
      continue;
    }
    // `_` only marks emphasis at word edges, so snake_case stays as text.
    const italic =
      char === "*"
        ? /^\*(?![\s*])(.+?)(?<!\s)\*/.exec(rest)
        : char === "_" && !/\w/.test(text[i - 1] ?? "")
          ? /^_(?![\s_])(.+?)(?<!\s)_(?!\w)/.exec(rest)
          : null;
    if (italic) {
      flush();
      runs.push(...parseInline(italic[1]!, { ...style, italic: true }));
      i += italic[0].length;
      continue;
    }
    plain += char;
    i += 1;
  }
  flush();
  return runs;
}

interface Block {
  /** Nesting level of a list item. */
  level?: number;
  ordered?: boolean;
  runs: Run[];
  style: DocParagraphStyle;
}

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
// Docs supports nine list levels.
const MAX_LIST_LEVEL = 8;

/** Split Markdown into paragraph blocks. */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  // Indents of the open list levels, so 2- and 4-space nesting both work.
  let indents: number[] = [];
  let fence: string | undefined;
  let open: string[] = [];
  const closeParagraph = () => {
    if (open.length) {
      blocks.push({ runs: parseInline(open.join(" ")), style: "NORMAL_TEXT" });
    }
    open = [];
  };
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .replace(DROPPED_CHARACTERS, "")
    .split("\n");
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch?.[1] === fence) {
        fence = undefined;
      } else {
        blocks.push({
          runs: line ? [{ style: { code: true }, text: line }] : [],
          style: "NORMAL_TEXT",
        });
      }
      continue;
    }
    if (fenceMatch) {
      closeParagraph();
      indents = [];
      fence = fenceMatch[1];
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      closeParagraph();
      if (!line.trim()) continue;
      indents = [];
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      indents = [];
      blocks.push({
        runs: parseInline(heading[2]!),
        style: `HEADING_${heading[1]!.length}` as DocParagraphStyle,
      });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      closeParagraph();
      const indent = item[1]!.replace(/\t/g, "    ").length;
      while (indents.length && indents.at(-1)! > indent) indents.pop();
      if (!indents.length || indents.at(-1)! < indent) indents.push(indent);
      blocks.push({
        level: Math.min(indents.length - 1, MAX_LIST_LEVEL),
        ordered: /\d/.test(item[2]!),
        runs: parseInline(item[3]!),
        style: "NORMAL_TEXT",
      });
      continue;
    }
    if (indents.length && /^\s/.test(line) && !open.length) {
      // An indented line after a list item continues that item.
      const last = blocks.at(-1)!;
      last.runs.push({ style: {}, text: " " }, ...parseInline(line.trim()));
      continue;
    }
    indents = [];
    // Markdown joins wrapped lines into one paragraph. Quote markers drop.
    open.push(line.trim().replace(/^>\s?/, ""));
  }
  closeParagraph();
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
  let previous: Block | undefined;
  for (const block of parseBlocks(markdown)) {
    if (result.text) result.text += "\n";
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
