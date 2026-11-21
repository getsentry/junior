import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  IS_CODE,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
} from "lexical";

import {
  splitComposerText,
  type ComposerTextPart,
} from "../composerReferences";
import { $composerPieces, type ComposerLookup } from "./composerEditorText";
import {
  parseMarkdownLines,
  type MarkdownLine,
  type MarkdownLineKind,
  type MarkdownSegment,
} from "./composerMarkdownSyntax";
import {
  $createComposerMarkerNode,
  $isComposerMarkerNode,
  type ComposerMarkerNode,
} from "./ComposerMarkerNode";

// A mention or reference chip stands for one character of a line.
const CHIP = "\uFFFC";

/** True when the node is code, where `$` and `@` are only text. */
export function $isInCode(node: LexicalNode): boolean {
  return $isTextNode(node) && node.hasFormat("code");
}

type Line = { nodes: LexicalNode[]; start: number };

/**
 * Style the draft's Markdown in place: split each line into marker and
 * text nodes with formats. The text does not change, so the draft stays
 * the raw Markdown that the message sends. Tokens outside code become
 * chips. The selection keeps its place in the text.
 */
export function $styleComposerDraft(lookup: ComposerLookup): void {
  const selection = $getSelection();
  const points = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus]
    : [];
  for (const paragraph of $getRoot().getChildren()) {
    if (!$isElementNode(paragraph)) continue;
    let lines = $lines(paragraph);
    const parsed = parseMarkdownLines(lines.map(lineText));
    const saved = points.flatMap((point) => {
      const at = $pointInLine(point, paragraph, lines);
      return at ? [{ point, ...at }] : [];
    });
    let changed = false;
    // From the last line, so the child indexes of earlier lines hold.
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      const pieces = $restyledLine(line, parsed[index]!, lookup);
      if (!pieces) continue;
      changed = true;
      paragraph.splice(
        line.start,
        line.nodes.length,
        pieces.map(({ node }) => node),
      );
      for (const at of saved) {
        if (at.line === index) at.offset = movedOffset(pieces, at.offset);
      }
    }
    if (!changed) continue;
    lines = $lines(paragraph);
    for (const at of saved) {
      $setPoint(at.point, paragraph, lines[at.line]!, at.offset);
    }
  }
}

/**
 * Show the markers of each span that the selection is in or touches, and
 * of each line that it is on. Hide the rest. Without focus, all hide.
 */
export function syncComposerMarkers(editor: LexicalEditor): void {
  const root = editor.getRootElement();
  const focused = Boolean(root?.contains(document.activeElement));
  editor.getEditorState().read(() => {
    const paragraphs = $getRoot().getChildren().filter($isElementNode);
    const selected = focused
      ? $selectedRanges(paragraphs)
      : new Map<string, [number, number]>();
    for (const paragraph of paragraphs) {
      for (const [index, line] of $lines(paragraph).entries()) {
        const range = selected.get(`${paragraph.getKey()}:${index}`);
        for (const { node, span } of $lineMarkers(line)) {
          const { edge, line: kind } = node.getMarker();
          const hidden =
            edge === "line"
              ? !range && (kind === "bullet" || kind === "quote")
              : !range || range[0] > span[1] || range[1] < span[0];
          editor
            .getElementByKey(node.getKey())
            ?.toggleAttribute("data-hidden", hidden);
        }
      }
    }
  });
}

/**
 * Move a caret that lands beside hidden markers, which take no space, to
 * the outer side of them: before an opening marker, after a closing one.
 * Then the caret is at the edge of the span, from either side, and each
 * arrow press after that moves over one character.
 */
export function placeCaretOutsideHiddenMarkers(editor: LexicalEditor): void {
  const isHidden = (node: LexicalNode | null): node is ComposerMarkerNode =>
    $isComposerMarkerNode(node) &&
    node.getMarker().edge !== "line" &&
    Boolean(editor.getElementByKey(node.getKey())?.hasAttribute("data-hidden"));
  const target = editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
    if (selection.anchor.type !== "text") return;
    const node = selection.anchor.getNode();
    const offset = selection.anchor.offset;
    const after =
      isHidden(node) && node.getMarker().edge === "close"
        ? node
        : offset === node.getTextContentSize()
          ? node.getNextSibling()
          : null;
    if (isHidden(after) && after.getMarker().edge === "close") {
      let last = after;
      for (let next = last.getNextSibling(); isHidden(next);) {
        if (next.getMarker().edge !== "close") break;
        last = next;
        next = last.getNextSibling();
      }
      return { key: last.getKey(), offset: last.getTextContentSize() };
    }
    const before =
      isHidden(node) && node.getMarker().edge === "open"
        ? node
        : offset === 0
          ? node.getPreviousSibling()
          : null;
    if (isHidden(before) && before.getMarker().edge === "open") {
      let first = before;
      for (let previous = first.getPreviousSibling(); isHidden(previous);) {
        if (previous.getMarker().edge !== "open") break;
        first = previous;
        previous = first.getPreviousSibling();
      }
      return { key: first.getKey(), offset: 0 };
    }
    return undefined;
  });
  if (!target) return;
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    selection.anchor.set(target.key, target.offset, "text");
    selection.focus.set(target.key, target.offset, "text");
  });
}

function $lines(paragraph: ElementNode): Line[] {
  const lines: Line[] = [{ nodes: [], start: 0 }];
  for (const [index, child] of paragraph.getChildren().entries()) {
    if ($isLineBreakNode(child)) lines.push({ nodes: [], start: index + 1 });
    else lines.at(-1)!.nodes.push(child);
  }
  return lines;
}

function nodeText(node: LexicalNode): string {
  if ($isTabNode(node)) return "\t";
  return $isTextNode(node) ? node.getTextContent() : CHIP;
}

function lineText(line: Line): string {
  return line.nodes.map(nodeText).join("");
}

// Tabs and chips keep their nodes when a line is styled again.
function isKept(node: LexicalNode): boolean {
  return $isTabNode(node) || !$isTextNode(node);
}

type Planned =
  | { kind: "text"; format: number; text: string }
  | {
      kind: "marker";
      format: number;
      marker: NonNullable<MarkdownSegment["marker"]>;
      line: MarkdownLineKind;
      text: string;
    }
  | { kind: "kept"; node: LexicalNode }
  | { kind: "token"; part: ComposerTextPart };

type Piece = { node: LexicalNode; oldLength: number; newLength: number };

// The nodes of a restyled line, or undefined when it is styled already.
function $restyledLine(
  line: Line,
  parsed: MarkdownLine,
  lookup: ComposerLookup,
): Piece[] | undefined {
  const kept = line.nodes.filter(isKept);
  const plan: Planned[] = [];
  for (const segment of parsed.segments) {
    for (const text of segment.text.split(/([\t\uFFFC])/)) {
      if (!text) continue;
      if (text === "\t" || text === CHIP) {
        const node = kept.shift();
        if (node) plan.push({ kind: "kept", node });
      } else if (segment.marker) {
        plan.push({
          kind: "marker",
          format: segment.format,
          line: parsed.kind,
          marker: segment.marker,
          text,
        });
      } else if (segment.format & IS_CODE) {
        plan.push({ kind: "text", format: segment.format, text });
      } else {
        for (const part of splitComposerText(text, lookup.origin)) {
          plan.push(
            "text" in part
              ? { kind: "text", format: segment.format, text: part.text }
              : { kind: "token", part },
          );
        }
      }
    }
  }
  const current = line.nodes.map($plannedFromNode);
  if (
    current.length === plan.length &&
    current.every((item, index) => samePlan(item, plan[index]!))
  ) {
    return undefined;
  }
  return plan.map((item): Piece => {
    switch (item.kind) {
      case "kept":
        return { node: item.node, oldLength: 1, newLength: 1 };
      case "text":
        return {
          node: $createTextNode(item.text).setFormat(item.format),
          oldLength: item.text.length,
          newLength: item.text.length,
        };
      case "marker":
        return {
          node: $createComposerMarkerNode(item.text, {
            ...item.marker,
            line: item.line,
          }).setFormat(item.format),
          oldLength: item.text.length,
          newLength: item.text.length,
        };
      case "token": {
        const [chip] = $composerPieces([item.part], lookup);
        return { node: chip!.node, oldLength: chip!.length, newLength: 1 };
      }
    }
  });
}

function $plannedFromNode(node: LexicalNode): Planned {
  if (isKept(node)) return { kind: "kept", node };
  if ($isComposerMarkerNode(node)) {
    const { line, ...marker } = node.getMarker();
    return {
      kind: "marker",
      format: node.getFormat(),
      line,
      marker,
      text: node.getTextContent(),
    };
  }
  return {
    kind: "text",
    format: $isTextNode(node) ? node.getFormat() : 0,
    text: node.getTextContent(),
  };
}

function samePlan(a: Planned, b: Planned): boolean {
  if (a.kind === "kept" || b.kind === "kept") {
    return a.kind === "kept" && b.kind === "kept" && a.node.is(b.node);
  }
  if (a.kind === "token" || b.kind === "token") return false;
  if (a.kind === "marker" && b.kind === "marker") {
    return (
      a.text === b.text &&
      a.format === b.format &&
      a.line === b.line &&
      a.marker.edge === b.marker.edge &&
      a.marker.span === b.marker.span
    );
  }
  return a.kind === b.kind && a.text === b.text && a.format === b.format;
}

// An offset in the old line text, in the restyled line. A caret inside a
// token that became a chip goes after the chip.
function movedOffset(pieces: Piece[], offset: number): number {
  let oldStart = 0;
  let newStart = 0;
  for (const { oldLength, newLength } of pieces) {
    if (offset <= oldStart + oldLength) {
      if (oldLength === newLength) return newStart + offset - oldStart;
      return offset === oldStart ? newStart : newStart + newLength;
    }
    oldStart += oldLength;
    newStart += newLength;
  }
  return newStart;
}

function $pointInLine(
  point: PointType,
  paragraph: ElementNode,
  lines: Line[],
): { line: number; offset: number } | undefined {
  if (point.type === "text") {
    const node = point.getNode();
    if (!node.getParent()?.is(paragraph)) return undefined;
    for (const [index, line] of lines.entries()) {
      let offset = 0;
      for (const child of line.nodes) {
        if (child.is(node))
          return { line: index, offset: offset + point.offset };
        offset += nodeText(child).length;
      }
    }
    return undefined;
  }
  if (point.key !== paragraph.getKey()) return undefined;
  for (const [index, line] of lines.entries()) {
    if (
      point.offset < line.start ||
      point.offset > line.start + line.nodes.length
    ) {
      continue;
    }
    const before = line.nodes.slice(0, point.offset - line.start);
    return {
      line: index,
      offset: before.reduce((sum, child) => sum + nodeText(child).length, 0),
    };
  }
  return undefined;
}

function $setPoint(
  point: PointType,
  paragraph: ElementNode,
  line: Line,
  offset: number,
): void {
  let start = 0;
  for (const [index, node] of line.nodes.entries()) {
    const length = nodeText(node).length;
    if ($isTextNode(node) && offset <= start + length) {
      point.set(node.getKey(), offset - start, "text");
      return;
    }
    if (!$isTextNode(node) && offset <= start) {
      point.set(paragraph.getKey(), line.start + index, "element");
      return;
    }
    start += length;
  }
  point.set(paragraph.getKey(), line.start + line.nodes.length, "element");
}

// Each inline or line marker of a line, with the offsets of its span.
function $lineMarkers(
  line: Line,
): { node: ComposerMarkerNode; span: [number, number] }[] {
  const spans = new Map<number, [number, number]>();
  const markers: { node: ComposerMarkerNode; id: number }[] = [];
  let offset = 0;
  for (const node of line.nodes) {
    const length = nodeText(node).length;
    if ($isComposerMarkerNode(node)) {
      const id = node.getMarker().span;
      const span = spans.get(id);
      spans.set(id, [span?.[0] ?? offset, offset + length]);
      markers.push({ node, id });
    }
    offset += length;
  }
  return markers.map(({ node, id }) => ({ node, span: spans.get(id)! }));
}

// The selected offsets of each line, keyed `paragraph:line`.
function $selectedRanges(
  paragraphs: ElementNode[],
): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return ranges;
  const located = [selection.anchor, selection.focus].map((point) => {
    for (const [order, paragraph] of paragraphs.entries()) {
      const at = $pointInLine(point, paragraph, $lines(paragraph));
      if (at) return { order, ...at };
    }
    return undefined;
  });
  const [a, b] = located;
  if (!a || !b) return ranges;
  const [start, end] = compareAt(a, b) <= 0 ? [a, b] : [b, a];
  for (let order = start.order; order <= end.order; order++) {
    const paragraph = paragraphs[order]!;
    for (const [index, line] of $lines(paragraph).entries()) {
      const at = { order, line: index, offset: 0 };
      if (compareAt({ ...at, offset: Infinity }, start) < 0) continue;
      if (compareAt(at, end) > 0) continue;
      const from =
        order === start.order && index === start.line ? start.offset : 0;
      const to =
        order === end.order && index === end.line
          ? end.offset
          : lineText(line).length;
      ranges.set(`${paragraph.getKey()}:${index}`, [from, to]);
    }
  }
  return ranges;
}

type At = { order: number; line: number; offset: number };

function compareAt(a: At, b: At): number {
  return a.order - b.order || a.line - b.line || a.offset - b.offset;
}
