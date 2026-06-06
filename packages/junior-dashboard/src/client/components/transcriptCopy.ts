type IntersectingRange = Pick<Range, "intersectsNode">;

type TranscriptCopySelection = Pick<
  Selection,
  "isCollapsed" | "rangeCount" | "toString"
> & {
  getRangeAt(index: number): IntersectingRange;
};

function selectionIntersectsNode(
  selection: TranscriptCopySelection | null,
  node: Node,
): boolean {
  if (
    !selection ||
    selection.isCollapsed ||
    selection.toString().length === 0
  ) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(node)) return true;
  }

  return false;
}

/** Decide when rich transcript copy should fall back to the raw message payload. */
export function shouldCopyRawTranscript(
  view: string,
  rawText: string,
  selection: TranscriptCopySelection | null,
  node: Node,
): boolean {
  if (view !== "rich" || !rawText) return false;
  return !selectionIntersectsNode(selection, node);
}
