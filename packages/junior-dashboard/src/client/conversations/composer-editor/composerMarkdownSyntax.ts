import {
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
} from "lexical";
import { parseMarkdown, type MarkdownNode } from "@sentry/junior-plugin-api";

/**
 * What one line of the draft is. List and quote markers show only when the
 * caret is on their line. Code fences always show. Lines in a code block
 * are code.
 */
export type MarkdownLineKind =
  | "bullet"
  | "code"
  | "fence"
  | "ordered"
  | "quote"
  | "text";

/**
 * One run of a line. A marker is Markdown syntax, such as `**`. Markers of
 * one span share its `span` number, and line markers have `span` -1.
 * `format` is a Lexical text format: the link text of `[text](url)` is
 * underlined.
 */
export type MarkdownSegment = {
  format: number;
  marker?: { edge: "close" | "line" | "open"; span: number };
  text: string;
};

/**
 * One line, split into the Markdown that styles it. `number` is the number
 * that an ordered list item renders with.
 */
export type MarkdownLine = {
  kind: MarkdownLineKind;
  number?: number;
  segments: MarkdownSegment[];
};

type Marker = NonNullable<MarkdownSegment["marker"]>;

const LINE_MARKER: Marker = { edge: "line", span: -1 };
const SPAN_FORMATS: Partial<Record<MarkdownNode["type"], number>> = {
  delete: IS_STRIKETHROUGH,
  emphasis: IS_ITALIC,
  link: IS_UNDERLINE,
  strong: IS_BOLD,
};

/**
 * Split the lines of a draft into its Markdown: the CommonMark and GFM
 * syntax that the parser finds, at the source offsets that it reports. The
 * segments of each line join back to exactly that line.
 */
export function parseMarkdownLines(lines: string[]): MarkdownLine[] {
  const text = lines.join("\n");
  const starts = lineStarts(lines);
  // The style of each character of the draft, by its offset.
  const formats = Array.from({ length: text.length }, () => 0);
  const markers: (Marker | undefined)[] = [];
  const kinds = lines.map((): MarkdownLineKind => "text");
  const numbers = new Map<number, number>();
  let nextSpan = 0;

  const mark = (start: number, end: number, marker: Marker) => {
    for (let at = start; at < end; at++) markers[at] ??= marker;
  };
  const format = (start: number, end: number, flag: number) => {
    for (let at = start; at < end; at++) formats[at]! |= flag;
  };
  // The source before the first child and after the last one is syntax.
  const spanMarkers = (
    node: Extract<MarkdownNode, { children: unknown }>,
    { start, end }: NodeAt,
  ) => {
    const first = node.children[0]?.position?.start.offset ?? end;
    const last = node.children.at(-1)?.position?.end.offset ?? first;
    const span = nextSpan++;
    mark(start, first, { edge: "open", span });
    mark(last, end, { edge: "close", span });
    format(start, end, SPAN_FORMATS[node.type] ?? 0);
  };

  // What each node type marks. A node's children are visited after it.
  const visitors: Visitors = {
    blockquote: (_, { start, firstLine, lastLine }) => {
      for (let line = firstLine; line <= lastLine; line++) {
        const from = line === firstLine ? start : starts[line]!;
        const to = quoteMarkerEnd(text, from);
        if (to === from) continue;
        mark(from, to, LINE_MARKER);
        // A list item visits first when the quote is inside it.
        if (kinds[line] === "text") kinds[line] = "quote";
      }
    },
    code: (_, { start, end, firstLine, lastLine }) => {
      // A fenced block starts at its fence. An indented one starts with
      // its indent.
      const fence = text[start];
      const fenced = fence === "`" || fence === "~";
      let length = 0;
      while (fenced && text[start + length] === fence) length++;
      for (let line = firstLine; line <= lastLine; line++) {
        const isFence =
          fenced &&
          (line === firstLine ||
            (line === lastLine && closesFence(lines[line]!, fence, length)));
        const from = line === firstLine ? start : starts[line]!;
        const to = Math.min(lineEnd(starts, text, line), end);
        kinds[line] = isFence ? "fence" : "code";
        if (isFence) mark(starts[line]!, to, LINE_MARKER);
        else format(from, to, IS_CODE);
      }
    },
    delete: spanMarkers,
    emphasis: spanMarkers,
    inlineCode: (_, { start, end }) => {
      let fence = 0;
      while (text[start + fence] === "`") fence++;
      const span = nextSpan++;
      mark(start, start + fence, { edge: "open", span });
      mark(end - fence, end, { edge: "close", span });
      format(start + fence, end - fence, IS_CODE);
    },
    link: (node, at) => {
      // A bare or `<url>` link is one piece of text, with no syntax to
      // show or hide.
      if (text[at.start] === "[") spanMarkers(node, at);
    },
    listItem: (node, { start, firstLine, list }) => {
      const content = node.children[0]?.position?.start;
      const markerEnd =
        content && content.line - 1 === firstLine
          ? content.offset!
          : lineEnd(starts, text, firstLine);
      mark(start, markerEnd, LINE_MARKER);
      kinds[firstLine] = list?.ordered ? "ordered" : "bullet";
      if (list?.ordered) numbers.set(firstLine, list.number);
    },
    strong: spanMarkers,
  };

  const visit = (node: MarkdownNode, list: NodeAt["list"]) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const at: NodeAt = {
      start,
      end,
      firstLine: node.position!.start.line - 1,
      lastLine: node.position!.end.line - 1,
      list,
    };
    runVisitor(visitors, node.type, node, at);
    if (!("children" in node)) return;
    for (const [index, child] of node.children.entries()) {
      visit(
        child,
        node.type === "list"
          ? {
              ordered: Boolean(node.ordered),
              number: (node.start ?? 1) + index,
            }
          : list,
      );
    }
  };

  visit(parseMarkdown(text), undefined);
  return lines.map((line, index) => {
    const parsed: MarkdownLine = {
      kind: kinds[index]!,
      segments: lineSegments(line, starts[index]!, formats, markers),
    };
    const number = numbers.get(index);
    if (number !== undefined) parsed.number = number;
    return parsed;
  });
}

// Where a node is in the draft. `list` is the list of a list item, with
// the number that the item renders with.
type NodeAt = {
  start: number;
  end: number;
  firstLine: number;
  lastLine: number;
  list: { ordered: boolean; number: number } | undefined;
};

// Each Markdown node by its type.
type NodeOf = { [Node in MarkdownNode as Node["type"]]: Node };

type Visitors = {
  [Type in keyof NodeOf]?: (node: NodeOf[Type], at: NodeAt) => void;
};

// Run the visitor of a node's type. Taking the type and the node apart
// lets TypeScript match the visitor to the node.
function runVisitor<Type extends keyof NodeOf>(
  visitors: Visitors,
  type: Type,
  node: NodeOf[Type],
  at: NodeAt,
): void {
  visitors[type]?.(node, at);
}

// The end of the quote markers at `from`: `>` with one optional space
// each, after the line's indent.
function quoteMarkerEnd(text: string, from: number): number {
  let at = from;
  while (text[at] === " " || text[at] === "\t") at++;
  if (text[at] !== ">") return from;
  while (text[at] === ">") {
    at++;
    if (text[at] === " " || text[at] === "\t") at++;
  }
  return at;
}

// A closing fence: at least `length` of the opening fence character, alone
// on its line after the indent and quote markers of its container.
function closesFence(line: string, fence: string, length: number): boolean {
  const trimmed = line.trimEnd();
  let at = trimmed.length;
  while (at > 0 && trimmed[at - 1] === fence) at--;
  return (
    trimmed.length - at >= length &&
    trimmed.slice(0, at).replaceAll(">", "").trim() === ""
  );
}

// Runs of characters with one format and marker. Markers carry their
// span's format, so `**` looks bold, but not code or link styles, whose
// padding and underline would show on hidden markers.
function lineSegments(
  line: string,
  start: number,
  formats: number[],
  markers: (Marker | undefined)[],
): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  for (let at = 0; at < line.length; at++) {
    const marker = markers[start + at];
    const format = marker
      ? formats[start + at]! & ~(IS_CODE | IS_UNDERLINE)
      : formats[start + at]!;
    const previous = segments.at(-1);
    if (previous && previous.format === format && previous.marker === marker) {
      previous.text += line[at];
      continue;
    }
    const segment: MarkdownSegment = { format, text: line[at]! };
    if (marker) segment.marker = marker;
    segments.push(segment);
  }
  return segments;
}

function lineStarts(lines: string[]): number[] {
  let offset = 0;
  return lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
}

function lineEnd(starts: number[], text: string, line: number): number {
  return (starts[line + 1] ?? text.length + 1) - 1;
}
