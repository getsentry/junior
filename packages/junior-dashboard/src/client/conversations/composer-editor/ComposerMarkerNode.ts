import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

import type {
  MarkdownLineKind,
  MarkdownSegment,
} from "./composerMarkdownSyntax";

type MarkerInfo = NonNullable<MarkdownSegment["marker"]> & {
  line: MarkdownLineKind;
};

type SerializedComposerMarker = Spread<
  { marker: MarkerInfo },
  SerializedTextNode
>;

// Hidden inline markers take no space but stay in the text, so the caret,
// copy, and `innerText` still see them. Hidden list and quote markers keep
// their width and show a glyph instead. An ordered list marker shows the
// number that the list renders, which `syncComposerMarkers` sets, at the
// end of its width, before the space.
const MARKER_CLASS = "text-dashboard-text-faint data-hidden:text-[0em]";
const LINE_MARKER_CLASS: Partial<Record<MarkdownLineKind, string>> = {
  bullet:
    "relative data-hidden:text-transparent data-hidden:before:absolute data-hidden:before:left-0 data-hidden:before:text-dashboard-text-muted data-hidden:before:content-['•']",
  ordered:
    "relative data-hidden:text-transparent data-hidden:before:absolute data-hidden:before:right-[0.25em] data-hidden:before:whitespace-nowrap data-hidden:before:text-dashboard-text-muted data-hidden:before:content-[attr(data-number)]",
  quote:
    "relative data-hidden:text-transparent data-hidden:before:absolute data-hidden:before:left-0 data-hidden:before:text-dashboard-text-faint data-hidden:before:content-['│']",
};

/**
 * Markdown syntax in the draft, such as `**` or `- `. It is real text: the
 * draft keeps it, and the message sends it. The composer hides it while
 * the caret is away from its span or line.
 */
export class ComposerMarkerNode extends TextNode {
  __marker: MarkerInfo;

  static override getType(): string {
    return "composer-marker";
  }

  static override clone(node: ComposerMarkerNode): ComposerMarkerNode {
    return new ComposerMarkerNode(node.__text, node.__marker, node.__key);
  }

  static override importJSON(
    json: SerializedComposerMarker,
  ): ComposerMarkerNode {
    return $createComposerMarkerNode(json.text, json.marker).updateFromJSON(
      json,
    );
  }

  constructor(text: string, marker: MarkerInfo, key?: NodeKey) {
    super(text, key);
    this.__marker = marker;
  }

  override exportJSON(): SerializedComposerMarker {
    return { ...super.exportJSON(), marker: this.__marker };
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.dataset["composerMarker"] = this.__marker.edge;
    const lineClass =
      this.__marker.edge === "line"
        ? LINE_MARKER_CLASS[this.__marker.line]
        : undefined;
    element.className = `${element.className} ${lineClass ?? MARKER_CLASS}`;
    return element;
  }

  /** The span or line that this marker belongs to. */
  getMarker(): MarkerInfo {
    return this.getLatest().__marker;
  }
}

/** Create a marker node of Markdown syntax. */
export function $createComposerMarkerNode(
  text: string,
  marker: MarkerInfo,
): ComposerMarkerNode {
  return $applyNodeReplacement(new ComposerMarkerNode(text, marker));
}

/** True when the node is Markdown syntax. */
export function $isComposerMarkerNode(
  node: LexicalNode | null | undefined,
): node is ComposerMarkerNode {
  return node instanceof ComposerMarkerNode;
}
