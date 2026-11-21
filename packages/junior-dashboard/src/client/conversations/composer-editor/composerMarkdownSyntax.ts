import {
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
} from "lexical";

/**
 * What one line of the draft is. Bullet and quote markers show only when
 * the caret is on their line. Ordered list numbers and code fences always
 * show. Lines between fences are code.
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

/** One line, split into the Markdown that styles it. */
export type MarkdownLine = {
  kind: MarkdownLineKind;
  segments: MarkdownSegment[];
};

const FENCE = /^\s*(```|~~~)/;
const LINE_PREFIX: [MarkdownLineKind, RegExp][] = [
  ["bullet", /^\s*[-*+] /],
  ["ordered", /^\s*\d{1,9}[.)] /],
  ["quote", /^> ?/],
];
const LINK = /^\[([^[\]]+)\]\(([^()\s]+)\)/;
const ESCAPABLE = /[\\`*_~[\]()<>#-]/;
const DELIMITERS: [string, number][] = [
  ["***", IS_BOLD | IS_ITALIC],
  ["___", IS_BOLD | IS_ITALIC],
  ["~~", IS_STRIKETHROUGH],
  ["**", IS_BOLD],
  ["__", IS_BOLD],
  ["*", IS_ITALIC],
  ["_", IS_ITALIC],
];

/**
 * Split the lines of a draft into Markdown: fenced code, list and quote
 * markers, and inline bold, italic, strike, code, and links. The segments
 * of each line join back to exactly that line.
 */
export function parseMarkdownLines(lines: string[]): MarkdownLine[] {
  let inFence = false;
  return lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return { kind: "fence", segments: lineMarker(line) };
    }
    if (inFence) {
      return {
        kind: "code",
        segments: line ? [{ format: IS_CODE, text: line }] : [],
      };
    }
    for (const [kind, prefix] of LINE_PREFIX) {
      const match = prefix.exec(line);
      if (!match) continue;
      return {
        kind,
        segments: [
          ...lineMarker(match[0]),
          ...parseInline(line.slice(match[0].length), 0, { next: 0 }),
        ],
      };
    }
    return { kind: "text", segments: parseInline(line, 0, { next: 0 }) };
  });
}

function lineMarker(text: string): MarkdownSegment[] {
  return text ? [{ format: 0, marker: { edge: "line", span: -1 }, text }] : [];
}

type SpanCounter = { next: number };

function parseInline(
  text: string,
  format: number,
  spans: SpanCounter,
): MarkdownSegment[] {
  const out: MarkdownSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ format, text: plain });
    plain = "";
  };
  // Markers carry the span's format, so `**` looks bold, but not code or
  // link styles, whose padding and underline would show on hidden markers.
  const span = (
    open: string,
    close: string,
    inner: MarkdownSegment[],
    spanFormat: number,
  ) => {
    flush();
    const id = spans.next++;
    const markerFormat = spanFormat & ~(IS_CODE | IS_UNDERLINE);
    out.push(
      { format: markerFormat, marker: { edge: "open", span: id }, text: open },
      ...inner,
      {
        format: markerFormat,
        marker: { edge: "close", span: id },
        text: close,
      },
    );
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      plain += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "`") {
      const run = runLength(text, i, "`");
      const close = findBacktickClose(text, i + run, run);
      if (close < 0) {
        plain += text.slice(i, i + run);
        i += run;
        continue;
      }
      const fence = text.slice(i, i + run);
      const content = text.slice(i + run, close);
      span(
        fence,
        fence,
        content ? [{ format: format | IS_CODE, text: content }] : [],
        format | IS_CODE,
      );
      i = close + run;
      continue;
    }
    const atom = atomAt(text, i);
    if (atom) {
      plain += atom;
      i += atom.length;
      continue;
    }
    const link = char === "[" ? LINK.exec(text.slice(i)) : null;
    if (link) {
      const linkFormat = format | IS_UNDERLINE;
      span(
        "[",
        `](${link[2]})`,
        parseInline(link[1]!, linkFormat, spans),
        linkFormat,
      );
      i += link[0].length;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      const run = runLength(text, i, char);
      const matched = matchDelimiter(text, i, run);
      if (!matched) {
        plain += text.slice(i, i + run);
        i += run;
        continue;
      }
      const { close, delimiter, delimiterFormat } = matched;
      const spanFormat = format | delimiterFormat;
      span(
        delimiter,
        delimiter,
        parseInline(text.slice(i + delimiter.length, close), spanFormat, spans),
        spanFormat,
      );
      i = close + delimiter.length;
      continue;
    }
    plain += char;
    i++;
  }
  flush();
  return out;
}

// The longest delimiter of the run at `start` that has a closing match.
function matchDelimiter(
  text: string,
  start: number,
  run: number,
): { close: number; delimiter: string; delimiterFormat: number } | undefined {
  for (const [delimiter, delimiterFormat] of DELIMITERS) {
    if (delimiter.length > run || !text.startsWith(delimiter, start)) continue;
    // A run longer than its delimiter, such as `****`, is text.
    if (delimiter.length !== run && run !== 3) continue;
    const contentStart = start + delimiter.length;
    if (/\s/.test(text[contentStart] ?? " ")) continue;
    if (delimiter[0] === "_" && isWordChar(text[start - 1])) continue;
    const close = findDelimiterClose(text, contentStart, delimiter);
    if (close > contentStart) return { close, delimiter, delimiterFormat };
  }
  return undefined;
}

// The start of the closing delimiter, skipping code and tokens, or -1.
function findDelimiterClose(
  text: string,
  from: number,
  delimiter: string,
): number {
  const char = delimiter[0]!;
  let j = from;
  while (j < text.length) {
    const here = text[j]!;
    if (here === "\\") {
      j += 2;
      continue;
    }
    if (here === "`") {
      const run = runLength(text, j, "`");
      const close = findBacktickClose(text, j + run, run);
      j = close < 0 ? j + run : close + run;
      continue;
    }
    const atom = atomAt(text, j);
    if (atom) {
      j += atom.length;
      continue;
    }
    if (here !== char) {
      j++;
      continue;
    }
    const run = runLength(text, j, char);
    // A run of three closes a span of one or two inside a span of the rest.
    const close =
      run === delimiter.length
        ? j
        : run === 3 && delimiter.length < 3
          ? j + run - delimiter.length
          : -1;
    if (
      close > from &&
      !/\s/.test(text[close - 1]!) &&
      !(char === "_" && isWordChar(text[j + run]))
    ) {
      return close;
    }
    j += run;
  }
  return -1;
}

// The start of a backtick run of exactly `run` after `from`, or -1.
function findBacktickClose(text: string, from: number, run: number): number {
  let j = text.indexOf("`", from);
  while (j >= 0) {
    const length = runLength(text, j, "`");
    if (length === run) return j;
    j = text.indexOf("`", j + length);
  }
  return -1;
}

// Text at `index` that inline Markdown does not split: a Slack or
// reference token, or a bare URL, which can hold `_` and `*`.
function atomAt(text: string, index: number): string | undefined {
  if (!isWordStart(text, index)) return undefined;
  const atom = /<[^<>]+>|https?:\/\/[^\s<>]+/gy;
  atom.lastIndex = index;
  return atom.exec(text)?.[0];
}

function runLength(text: string, start: number, char: string): number {
  let end = start;
  while (text[end] === char) end++;
  return end - start;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function isWordStart(text: string, index: number): boolean {
  return !isWordChar(text[index - 1]);
}
