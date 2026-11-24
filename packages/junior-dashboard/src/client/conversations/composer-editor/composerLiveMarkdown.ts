import {
  $createTabNode,
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
import { listEnter } from "./composerMarkdownLists";
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

/** True when the node is code, where `$` and `@` are only text. */
export function $isInCode(node: LexicalNode): boolean {
  return $isTextNode(node) && node.hasFormat("code");
}

type Line = { nodes: LexicalNode[]; start: number };

/**
 * Style the draft's Markdown in place: split each line into marker and
 * text nodes with formats. The text does not change, so the draft stays
 * the raw Markdown that the message sends. Tokens outside code become
 * chips. The selection keeps its offset in the text. Without `markdown`,
 * the draft is plain text with chips.
 */
export function $styleComposerDraft(
  lookup: ComposerLookup,
  markdown: boolean,
): void {
  const selection = $getSelection();
  const points = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus]
    : [];
  for (const paragraph of $getRoot().getChildren()) {
    if (!$isElementNode(paragraph)) continue;
    const map = $sourceMap(paragraph);
    const texts = draftLines(map);
    const parsed = markdown ? parseMarkdownLines(texts) : texts.map(plainLine);
    const saved = points.flatMap((point) => {
      const offset = $offsetOf(point, paragraph, map);
      return offset === undefined ? [] : [{ point, offset }];
    });
    const lines = $lines(paragraph);
    let changed = false;
    // From the last line, so the child indexes of earlier lines hold.
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      const nodes = $restyledLine(line, parsed[index]!, lookup);
      if (!nodes) continue;
      changed = true;
      paragraph.splice(line.start, line.nodes.length, nodes);
    }
    if (!changed) continue;
    // The text is the same, so each offset finds its place in the new
    // nodes.
    const restyled = $sourceMap(paragraph);
    for (const { point, offset } of saved) {
      $setPointAt(point, paragraph, restyled, offset);
    }
  }
}

/**
 * Continue a Markdown list when Enter ends a list item, with the next
 * item's marker on a new line. Enter on an item with only its marker
 * removes the marker, which ends the list. False when the caret is not at
 * the end of a list item.
 */
export function $enterInMarkdownList(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const { anchor } = selection;
  const paragraph =
    anchor.type === "element" ? anchor.getNode() : anchor.getNode().getParent();
  if (!$isElementNode(paragraph)) return false;
  const map = $sourceMap(paragraph);
  const offset = $offsetOf(anchor, paragraph, map);
  if (offset === undefined) return false;
  const texts = draftLines(map);
  const at = lineAt(texts, offset);
  const text = texts[at.line]!;
  const { kind, number } = parseMarkdownLines(texts)[at.line]!;
  const enter =
    at.offset === text.length && (kind === "bullet" || kind === "ordered")
      ? listEnter(text, number)
      : undefined;
  if (!enter) return false;
  if (enter.kind === "continue") {
    selection.insertRawText(`\n${enter.marker}`);
    return true;
  }
  const line = $lines(paragraph)[at.line]!;
  for (const node of line.nodes) node.remove();
  anchor.set(paragraph.getKey(), line.start, "element");
  selection.focus.set(paragraph.getKey(), line.start, "element");
  return true;
}

/**
 * Show the markers of each span that the selection is in or touches, and
 * of each line that it is on. Hide the rest. Without focus, all hide.
 * Hidden ordered list markers show the number that the list renders.
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
      const range = selected.get(paragraph.getKey());
      const map = $sourceMap(paragraph);
      const texts = draftLines(map);
      const lines = parseMarkdownLines(texts);
      const touches = ([start, end]: [number, number]) =>
        Boolean(range && range[0] <= end && range[1] >= start);
      for (const { node, span, line, lineIndex } of $markers(map, texts)) {
        const { edge, line: kind } = node.getMarker();
        const element = editor.getElementByKey(node.getKey());
        const hidden =
          edge === "line" ? kind !== "fence" && !touches(line) : !touches(span);
        element?.toggleAttribute("data-hidden", hidden);
        const number = lines[lineIndex]?.number;
        if (element && edge === "line" && number !== undefined) {
          const delimiter = node.getTextContent().trimEnd().slice(-1);
          element.dataset["number"] = `${number}${delimiter}`;
        }
      }
    }
  });
}

/**
 * Move a caret that a key puts beside hidden markers, which take no
 * space, to the outer side of them: before an opening marker, after a
 * closing one.
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

// Each child of a paragraph with the offsets of its text in the
// paragraph's text: the source map between the text and the nodes. A chip
// covers its token.
type Source = { node: LexicalNode; start: number; end: number }[];

function $sourceMap(paragraph: ElementNode): Source {
  let offset = 0;
  return paragraph.getChildren().map((node) => {
    const start = offset;
    offset += node.getTextContentSize();
    return { node, start, end: offset };
  });
}

// A chip stands for its token, which may hold Markdown syntax of its own.
const CHIP = "\uFFFC";

// The lines of the draft to parse: its text, with each chip as a run of
// `CHIP` as long as its token, so the parser sees a chip as one opaque word
// and every offset stays the same.
function draftLines(map: Source): string[] {
  return map
    .map(({ node }) =>
      isChip(node)
        ? CHIP.repeat(node.getTextContentSize())
        : node.getTextContent(),
    )
    .join("")
    .split("\n");
}

function $offsetOf(
  point: PointType,
  paragraph: ElementNode,
  map: Source,
): number | undefined {
  if (point.type === "element") {
    if (point.key !== paragraph.getKey()) return undefined;
    return map[point.offset]?.start ?? map.at(-1)?.end ?? 0;
  }
  const at = map.find(({ node }) => node.getKey() === point.key);
  return at ? at.start + point.offset : undefined;
}

// Put the point at a text offset. An offset in a chip's token goes after
// the chip.
function $setPointAt(
  point: PointType,
  paragraph: ElementNode,
  map: Source,
  offset: number,
): void {
  for (const [index, { node, start, end }] of map.entries()) {
    if ($isTextNode(node) && offset <= end) {
      point.set(node.getKey(), offset - start, "text");
      return;
    }
    if (!$isTextNode(node) && offset < end) {
      const after = offset > start ? 1 : 0;
      point.set(paragraph.getKey(), index + after, "element");
      return;
    }
  }
  point.set(paragraph.getKey(), map.length, "element");
}

// The line of a text offset, and the offset in that line.
function lineAt(
  texts: string[],
  offset: number,
): { line: number; offset: number } {
  let start = 0;
  for (const [line, text] of texts.entries()) {
    if (offset <= start + text.length) return { line, offset: offset - start };
    start += text.length + 1;
  }
  return { line: texts.length - 1, offset: texts.at(-1)!.length };
}

function plainLine(text: string): MarkdownLine {
  return { kind: "text", segments: text ? [{ format: 0, text }] : [] };
}

// Tabs and chips keep their nodes when a line is styled again.
function isKept(node: LexicalNode): boolean {
  return $isTabNode(node) || !$isTextNode(node);
}

function isChip(node: LexicalNode): boolean {
  return !$isTextNode(node) && !$isLineBreakNode(node);
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

// The nodes of a restyled line, or undefined when it is styled already.
// Its text stays the same: a chip keeps the token text that it stands for.
function $restyledLine(
  line: Line,
  parsed: MarkdownLine,
  lookup: ComposerLookup,
): LexicalNode[] | undefined {
  // The tabs and chips of the line, by their offset in it.
  const kept = new Map<number, LexicalNode>();
  let text = "";
  for (const node of line.nodes) {
    if (isKept(node)) kept.set(text.length, node);
    text += node.getTextContent();
  }
  const plan: Planned[] = [];
  let offset = 0;
  let end = 0;
  for (const segment of parsed.segments) {
    end += segment.text.length;
    const plain = !segment.marker && !(segment.format & IS_CODE);
    while (offset < end) {
      // A chip in code or syntax is its token text.
      const node = kept.get(offset);
      if (node && ($isTabNode(node) || plain)) {
        plan.push({ kind: "kept", node });
        offset += node.getTextContentSize();
        continue;
      }
      let to = offset + 1;
      while (to < end && !kept.has(to)) to++;
      plan.push(
        ...plannedText(text.slice(offset, to), segment, parsed.kind, lookup),
      );
      offset = to;
    }
  }
  const current = line.nodes.map($plannedFromNode);
  if (
    current.length === plan.length &&
    current.every((item, index) => samePlan(item, plan[index]!))
  ) {
    return undefined;
  }
  return plan.map((item): LexicalNode => {
    switch (item.kind) {
      case "kept":
        return item.node;
      case "text":
        return item.text === "\t"
          ? $createTabNode()
          : $createTextNode(item.text).setFormat(item.format);
      case "marker":
        return $createComposerMarkerNode(item.text, {
          ...item.marker,
          line: item.line,
        }).setFormat(item.format);
      case "token":
        return $composerPieces([item.part], lookup)[0]!.node;
    }
  });
}

// The nodes for text of a segment. Tokens outside code and syntax become
// chips.
function plannedText(
  text: string,
  segment: MarkdownSegment,
  line: MarkdownLineKind,
  lookup: ComposerLookup,
): Planned[] {
  const parts =
    segment.marker || segment.format & IS_CODE
      ? [{ text }]
      : splitComposerText(text, lookup.origin);
  return parts.flatMap((part): Planned[] => {
    if (!("text" in part)) return [{ kind: "token", part }];
    return part.text
      .split(/(\t)/)
      .filter(Boolean)
      .map((piece): Planned => {
        if (piece === "\t") return { kind: "text", format: 0, text: piece };
        if (!segment.marker) {
          return { kind: "text", format: segment.format, text: piece };
        }
        return {
          kind: "marker",
          format: segment.format,
          line,
          marker: segment.marker,
          text: piece,
        };
      });
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

// Each marker of a paragraph with the offsets of its span and its line.
function $markers(
  map: Source,
  texts: string[],
): {
  node: ComposerMarkerNode;
  span: [number, number];
  line: [number, number];
  lineIndex: number;
}[] {
  const spans = new Map<number, [number, number]>();
  const markers = map.flatMap(({ node, start, end }) => {
    if (!$isComposerMarkerNode(node)) return [];
    const id = node.getMarker().span;
    const span = spans.get(id);
    spans.set(id, [span?.[0] ?? start, end]);
    const at = lineAt(texts, start);
    const lineStart = start - at.offset;
    const line: [number, number] = [
      lineStart,
      lineStart + texts[at.line]!.length,
    ];
    return [{ node, id, line, lineIndex: at.line }];
  });
  return markers.map(({ id, ...marker }) => ({
    ...marker,
    span: spans.get(id)!,
  }));
}

// The selected offsets of each paragraph, keyed by its node key.
function $selectedRanges(
  paragraphs: ElementNode[],
): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return ranges;
  const located = [selection.anchor, selection.focus].map((point) => {
    for (const [order, paragraph] of paragraphs.entries()) {
      const offset = $offsetOf(point, paragraph, $sourceMap(paragraph));
      if (offset !== undefined) return { order, offset };
    }
    return undefined;
  });
  const [a, b] = located;
  if (!a || !b) return ranges;
  const [start, end] =
    (a.order - b.order || a.offset - b.offset) <= 0 ? [a, b] : [b, a];
  for (let order = start.order; order <= end.order; order++) {
    const paragraph = paragraphs[order]!;
    ranges.set(paragraph.getKey(), [
      order === start.order ? start.offset : 0,
      order === end.order ? end.offset : paragraph.getTextContentSize(),
    ]);
  }
  return ranges;
}
