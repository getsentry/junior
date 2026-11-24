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
const FENCE = /^[ \t]*(```|~~~)/;
const FENCED_CODE = /^ {0,3}(```|~~~)/;
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
  // The marker at the start of each line in a block quote.
  const quoteMarkers = (
    node: MarkdownNode,
    firstLine: number,
    lastLine: number,
  ) => {
    const quoteMarker = /[ \t]*(?:>[ \t]?)+/y;
    for (let line = firstLine; line <= lastLine; line++) {
      quoteMarker.lastIndex =
        line === firstLine ? node.position!.start.offset! : starts[line]!;
      const match = quoteMarker.exec(text);
      if (!match?.[0].includes(">")) continue;
      mark(match.index, match.index + match[0].length, LINE_MARKER);
      kinds[line] = "quote";
    }
  };

  const visit = (node: MarkdownNode, ordered: boolean, number: number) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const firstLine = node.position!.start.line - 1;
    const lastLine = node.position!.end.line - 1;
    switch (node.type) {
      case "blockquote":
        quoteMarkers(node, firstLine, lastLine);
        break;
      case "listItem": {
        const content = node.children[0]?.position?.start;
        const markerEnd =
          content && content.line - 1 === firstLine
            ? content.offset!
            : lineEnd(starts, text, firstLine);
        mark(start, markerEnd, LINE_MARKER);
        kinds[firstLine] = ordered ? "ordered" : "bullet";
        if (ordered) numbers.set(firstLine, number);
        break;
      }
      case "code": {
        const isFenced = FENCED_CODE.test(text.slice(start));
        for (let line = firstLine; line <= lastLine; line++) {
          const fenced =
            isFenced &&
            (line === firstLine ||
              (line === lastLine && FENCE.test(lines[line]!)));
          const from = line === firstLine ? start : starts[line]!;
          const to = Math.min(lineEnd(starts, text, line), end);
          kinds[line] = fenced ? "fence" : "code";
          if (fenced) mark(starts[line]!, to, LINE_MARKER);
          else format(from, to, IS_CODE);
        }
        return;
      }
      case "inlineCode": {
        const source = text.slice(start, end);
        const fence = /^`+/.exec(source)![0].length;
        const span = nextSpan++;
        mark(start, start + fence, { edge: "open", span });
        mark(end - fence, end, { edge: "close", span });
        format(start + fence, end - fence, IS_CODE);
        return;
      }
      case "link":
        // A bare or `<url>` link is one piece of text, with no syntax to
        // show or hide.
        if (text[start] !== "[") return;
        spanMarkers(node, start, end);
        break;
      case "delete":
      case "emphasis":
      case "strong":
        spanMarkers(node, start, end);
        break;
      default:
        break;
    }
    if (!("children" in node)) return;
    const list = node.type === "list" ? node : undefined;
    for (const [index, child] of node.children.entries()) {
      visit(
        child,
        list ? Boolean(list.ordered) : ordered,
        (list?.start ?? 1) + index,
      );
    }
  };

  // The source before the first child and after the last one is syntax.
  const spanMarkers = (
    node: Extract<MarkdownNode, { children: unknown }>,
    start: number,
    end: number,
  ) => {
    const first = node.children[0]?.position?.start.offset ?? end;
    const last = node.children.at(-1)?.position?.end.offset ?? first;
    const span = nextSpan++;
    mark(start, first, { edge: "open", span });
    mark(last, end, { edge: "close", span });
    format(start, end, SPAN_FORMATS[node.type] ?? 0);
  };

  visit(parseMarkdown(text), false, 1);
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
